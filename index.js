/**
 * Host half of the UI testing plugin: owns a real headless Chromium and drives it over CDP.
 * The client half only renders frames and forwards input, so nothing here can steal window focus.
 */
import { spawn } from 'node:child_process';
import { accessSync, constants as fsConstants, mkdtempSync, readFileSync, realpathSync, rmSync, statSync, unlinkSync } from 'node:fs';
import { mkdtemp, readFile, realpath, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { delimiter, isAbsolute, join, sep } from 'node:path';
import { fileURLToPath } from 'node:url';
import { FrameSource } from './frame-source.js';
import { attachFramePush } from './frame-push.js';
import { createHash, randomUUID } from 'node:crypto';
import http from 'node:http';
import https from 'node:https';
import { performance } from 'node:perf_hooks';
import { BrowserError, Cdp, asBrowserError, checkAbort, abortable, redactUrl, redactText, validateTarget } from './browser-safety.js';
import {
  CAPTURE_LIMITS, checkPixelSize, createCaptureMapping, decodePng, detectImageAnomaly,
  expectedPixelSize, hasPositiveOutputSize, inspectPng, projectCaptureMapping, publishCapture, resolveCapturePath,
} from './capture-p0.js';
// Web T3 static vision (docs/t3-vision.md, docs/t3-implementation-plan.md §2). The Host layer never
// re-implements the pixel algorithms: it validates arguments, resolves sources, owns the product
// store per scope, delivers the single PNG and implements the act/check decision rules on top of
// the pure module API.
import * as vision from './vision-t3.js';
import { createBaselineStore } from './vision-baseline.js';
// Web P0 network (docs/network-p0.md). The Host layer owns CDP collection, the single Fetch
// dispatcher and the 7 tool surfaces; every projection/aggregation/evidence rule lives in the
// pure module so it can be unit tested without a browser.
import * as network from './network-p0.js';
export { BrowserError, Cdp } from './browser-safety.js';

export const inject = ['tools', 'webServer'];

/**
 * Chromium/Chrome executable discovery (contract §9.3).
 *
 * Nothing is resolved at module load: a deployment may mount the browser later, a test may set
 * `DSH_UI_TESTING_CHROME` after importing this module, and a missing browser must not make the
 * whole plugin fail to load. Resolution happens once, lazily, right before the spawn, and the
 * result is cached (keyed by the configured value, so changing the env var re-resolves).
 * Everything reported back is a path — the configuration never holds secrets.
 */
const CHROME_ENV = 'DSH_UI_TESTING_CHROME';
/** The existing install keeps priority; then PATH order (no cwd, no other profile search). */
const CHROME_DEFAULT_CANDIDATE = '/opt/google/chrome/chrome';
/** Per-directory PATH order is fixed: stable package first. */
const CHROME_PATH_NAMES = Object.freeze(['google-chrome-stable', 'google-chrome', 'chromium', 'chromium-browser']);
/** Platform-adaptive tail (macOS application bundles); Linux is covered by the paths above. */
const CHROME_MAC_CANDIDATES = Object.freeze([
  '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome',
  '/Applications/Google Chrome Canary.app/Contents/MacOS/Google Chrome Canary',
  '/Applications/Chromium.app/Contents/MacOS/Chromium',
]);
/** Keep a failed-discovery message bounded even with a long PATH. */
const CHROME_CANDIDATE_LIMIT = 24;
let chromeResolution;

function isExecutableFile(candidate) {
  try {
    return statSync(candidate).isFile() && (accessSync(candidate, fsConstants.X_OK), true);
  } catch {
    return false;
  }
}

/** PATH directories: deduped, empty entries dropped (an empty entry must never mean cwd). */
function searchDirsFrom(pathDirs) {
  const dirs = pathDirs === undefined ? String(process.env.PATH || '').split(delimiter) : pathDirs;
  return [...new Set(dirs.filter(Boolean))];
}

function chromeCandidates(defaultCandidate, dirs, macCandidates) {
  return [...new Set([
    ...(defaultCandidate ? [defaultCandidate] : []),
    ...dirs.flatMap((dir) => CHROME_PATH_NAMES.map((name) => join(dir, name))),
    ...macCandidates,
  ])];
}

/** UNSUPPORTED/capability/false: no usable browser. The message lists candidates, never secrets. */
function chromeUnsupported(reason, candidates) {
  const unique = [...new Set(candidates)];
  const shown = unique.slice(0, CHROME_CANDIDATE_LIMIT);
  const suffix = unique.length > shown.length ? ` …等共 ${unique.length} 个候选` : '';
  const listed = shown.length ? `；已尝试：${shown.join('、')}${suffix}` : '；没有可尝试的候选路径';
  return new BrowserError('UNSUPPORTED', `${reason}${listed}`, {
    env: CHROME_ENV, candidates: shown, candidateCount: unique.length,
  });
}

/**
 * Resolve the browser binary.
 *
 * `override` ({present, value}) / `pathDirs` / `defaultCandidate` / `macCandidates` exist only so
 * a probe can exercise the search order without touching the host environment; production
 * callers pass nothing and get the cached answer.
 */
export function resolveChromeExecutable({ override, pathDirs, defaultCandidate = CHROME_DEFAULT_CANDIDATE, macCandidates = CHROME_MAC_CANDIDATES } = {}) {
  const explicit = override !== undefined
    ? override
    : { present: CHROME_ENV in process.env, value: process.env[CHROME_ENV] };
  const cacheable = override === undefined && pathDirs === undefined
    && defaultCandidate === CHROME_DEFAULT_CANDIDATE && macCandidates === CHROME_MAC_CANDIDATES;
  const cacheKey = explicit.present ? `${CHROME_ENV}=${explicit.value}` : '(default)';
  if (cacheable && chromeResolution && chromeResolution.key === cacheKey) return chromeResolution.path;

  if (explicit.present) {
    const raw = explicit.value === undefined || explicit.value === null ? '' : String(explicit.value);
    // An explicit override is authoritative: an unusable value is an operator error, not a
    // reason to silently run a different browser.
    if (raw === '') throw new BrowserError('INVALID_ARGUMENT', `${CHROME_ENV} 不能是空字符串；请删除该变量或给出绝对路径/命令名`);
    if (raw.includes('\0')) throw new BrowserError('INVALID_ARGUMENT', `${CHROME_ENV} 不能包含 NUL 字符`);
    if (!isAbsolute(raw)) {
      if (/[\\/]/.test(raw)) throw new BrowserError('INVALID_ARGUMENT', `${CHROME_ENV} 只接受绝对路径或 PATH 中的单个命令名：${raw}`);
      const tried = searchDirsFrom(pathDirs).map((dir) => join(dir, raw));
      const hit = tried.find(isExecutableFile);
      if (!hit) throw chromeUnsupported(`${CHROME_ENV} 指定的命令在 PATH 中不可执行：${raw}`, tried);
      if (cacheable) chromeResolution = { key: cacheKey, path: hit };
      return hit;
    }
    if (!isExecutableFile(raw)) throw chromeUnsupported(`${CHROME_ENV} 指向的 Chrome 不可用（不存在或不可执行）：${raw}`, [raw]);
    if (cacheable) chromeResolution = { key: cacheKey, path: raw };
    return raw;
  }

  const candidates = chromeCandidates(defaultCandidate, searchDirsFrom(pathDirs), macCandidates);
  const found = candidates.find(isExecutableFile);
  if (!found) throw chromeUnsupported('找不到可用的 Chrome/Chromium 可执行文件', candidates);
  if (cacheable) chromeResolution = { key: cacheKey, path: found };
  return found;
}

const ROUTE_PREFIX = '/plugins/ui-testing';
const NETWORK_LIMIT = 300;
const AGENT_HOLD_MS = 15000;
/** Bounded retry for the exact mkdtemp profile cleanup (transient ENOTEMPTY/EBUSY/EPERM). */
const PROFILE_RM_RETRIES = 5;
const PROFILE_RM_RETRY_DELAY_MS = 50;
/** How long a reload / history command may take to commit its main-frame navigation. */
const COMMIT_TIMEOUT_MS = 10000;
/** Throttle for the merged background title/url/history read (UI polls at 500ms / 80ms). */
const METADATA_THROTTLE_MS = 250;
const SKILL_NAME = 'ui-testing';
const SKILL_DIR = fileURLToPath(new URL('./skills/ui-testing/', import.meta.url));
const SKILL_FALLBACK_DESCRIPTION =
  'Web T1 browser debugging through the bundled structured tools (browser_navigate, browser_eval, ' +
  'browser_input, browser_network, browser_computed_style, browser_screenshot, browser_state, browser_capabilities, ' +
  'browser_http_request) plus the Web T2 structured GUI tools (browser_snapshot, browser_click, browser_type, ' +
  'browser_scroll, browser_fill_form, browser_node_state, browser_wait_for). Use for authorized web UI inspection, ' +
  'interaction, API requests and verification; T3-T4 are not implemented.';

/**
 * CDP Input modifier bitmask: Alt=1, Ctrl=2, Meta=4, Shift=8 (see Input.dispatchKeyEvent).
 * `browser_input` accepts either the string form ['alt','ctrl','meta','shift'] or the raw mask.
 */
const MODIFIER_BITS = Object.freeze({ alt: 1, ctrl: 2, meta: 4, shift: 8 });
const MODIFIER_MASK = Object.values(MODIFIER_BITS).reduce((mask, bit) => mask | bit, 0);
/** Key event types the CDP Input domain actually accepts. */
const KEY_EVENT_TYPES = Object.freeze(['keyDown', 'keyUp', 'rawKeyDown', 'char']);
/** CDP pointer types (Input.dispatchMouseEvent.pointerType). */

/** The UI history projection when no CDP navigation history is available (or not running). */
function emptyHistory() {
  return { available: false, index: -1, length: 0, canGoBack: false, canGoForward: false };
}

function normalizeModifiers(value) {
  if (value === undefined || value === null) return 0;
  if (Array.isArray(value)) {
    let mask = 0;
    for (const name of value) {
      const bit = typeof name === 'string' ? MODIFIER_BITS[name.trim().toLowerCase()] : undefined;
      if (!bit) throw new BrowserError('INVALID_ARGUMENT', `非法修饰键：${JSON.stringify(name)}（可用 alt/ctrl/meta/shift）`);
      mask |= bit;
    }
    return mask;
  }
  if (Number.isInteger(value)) {
    if (value < 0 || (value & ~MODIFIER_MASK) !== 0) {
      throw new BrowserError('INVALID_ARGUMENT', `modifiers 位掩码必须是 0–${MODIFIER_MASK} 的整数，收到 ${value}`);
    }
    return value;
  }
  throw new BrowserError('INVALID_ARGUMENT', 'modifiers 必须是字符串数组（alt/ctrl/meta/shift）或 CDP 位掩码整数');
}

/**
 * CDP `Input.dispatchMouseEvent.pointerType` is a *string* enum (`mouse`/`pen`), not a bitmask.
 * The integer 1/2 form stays accepted for compatibility with earlier calls, but is normalized to
 * the string CDP actually understands — passing 1/2 made Chromium reject the whole batch with
 * "Invalid parameters", so pen events never reached the page.
 */
function normalizePointerType(value) {
  if (value === undefined || value === null) return undefined;
  if (typeof value === 'string') {
    const name = value.trim().toLowerCase();
    if (name === 'mouse' || name === 'pen') return name;
  }
  if (value === 1) return 'mouse';
  if (value === 2) return 'pen';
  throw new BrowserError('INVALID_ARGUMENT', 'pointerType 只支持 mouse/pen（兼容 CDP 的 1/2）');
}

function normalizeKeyEventType(value) {
  if (!KEY_EVENT_TYPES.includes(value)) {
    throw new BrowserError('INVALID_ARGUMENT', `key 事件 type 无效：${JSON.stringify(value)}（可用 ${KEY_EVENT_TYPES.join('/')}）`);
  }
  return value;
}

/**
 * Turn one caller-supplied input event into CDP parameters.
 * Validation happens here, before the browser is started, so bad arguments never launch Chromium.
 */
function prepareInputEvent(event) {
  const modifiers = normalizeModifiers(event.modifiers);
  if (event.kind === 'mouse') {
    return {
      kind: 'mouse',
      params: {
        type: event.type,
        x: event.x,
        y: event.y,
        button: event.button || 'left',
        buttons: Number.isFinite(event.buttons) ? event.buttons : 0,
        clickCount: event.clickCount || 0,
        modifiers,
        ...(event.pointerType === undefined ? {} : { pointerType: normalizePointerType(event.pointerType) }),
      },
    };
  }
  if (event.kind === 'wheel') {
    return {
      kind: 'wheel',
      params: {
        type: 'mouseWheel',
        x: event.x,
        y: event.y,
        deltaX: event.deltaX || 0,
        deltaY: event.deltaY || 0,
        modifiers,
      },
    };
  }
  if (event.kind === 'key') {
    return {
      kind: 'key',
      params: {
        type: normalizeKeyEventType(event.type),
        key: event.key,
        code: event.code,
        modifiers,
        text: event.text,
        // Optional CDP key fields: JSON.stringify drops the undefined ones, so old minimal
        // calls ({kind,type,key,text}) keep the exact payload they had before.
        unmodifiedText: event.unmodifiedText,
        windowsVirtualKeyCode: event.virtualKeyCode,
        autoRepeat: typeof event.autoRepeat === 'boolean' ? event.autoRepeat : undefined,
        commands: Array.isArray(event.commands) ? event.commands.map(String) : undefined,
        location: Number.isInteger(event.location) ? event.location : undefined,
        isKeypad: typeof event.isKeypad === 'boolean' ? event.isKeypad : undefined,
      },
    };
  }
  return { kind: 'text', params: { text: event.text } };
}

/**
 * Lossless JSON projection for every tool result.
 *
 * The DSH host snapshots each tool value with `@deepseek-ai/dsh-util-values` `snapshotJsonValue`,
 * which rejects a value when *any* own property is `undefined`, when a number is non-finite or
 * `-0`, when an array is sparse, or when an object is a class instance; the call then fails with
 * `INVALID_TOOL_OUTPUT` ("value is not lossless JSON") even though the action itself succeeded.
 * Projecting at the tool boundary keeps one absent optional field from killing a finished action.
 * Dropped/coerced values are reported in `notes` instead of being silently invented.
 */
function losslessJson(value, path = 'value', notes = []) {
  const type = typeof value;
  if (value === null) return null;
  if (type === 'string' || type === 'boolean') return value;
  if (type === 'number') {
    if (!Number.isFinite(value) || Object.is(value, -0)) {
      notes.push(`${path}: 非有限数字已转 null`);
      return null;
    }
    return value;
  }
  if (type === 'undefined' || type === 'function' || type === 'symbol' || type === 'bigint') {
    notes.push(`${path}: ${type} 已剔除`);
    return undefined;
  }
  if (Array.isArray(value)) {
    const out = [];
    for (let index = 0; index < value.length; index += 1) {
      const clean = losslessJson(value[index], `${path}[${index}]`, notes);
      out.push(clean === undefined ? null : clean);
    }
    return out;
  }
  if (value instanceof Error) {
    return losslessJson({ name: value.name, message: value.message, code: value.code }, path, notes);
  }
  const out = {};
  for (const key of Object.keys(value)) {
    const clean = losslessJson(value[key], `${path}.${key}`, notes);
    if (clean === undefined) continue;
    // A remote header can be literally named `__proto__`: a plain assignment would replace the
    // prototype and make the host's lossless-JSON snapshot reject the whole call.
    Object.defineProperty(out, key, { value: clean, enumerable: true, configurable: true, writable: true });
  }
  return out;
}

/**
 * Project a host attachment reference into plain JSON fields (the host value snapshot rejects
 * class instances and getter-only objects). `id` is kept only when the service exposes it.
 */
function projectAttachment(attachment) {
  if (!attachment || typeof attachment !== 'object') return undefined;
  const pick = (key) => (attachment[key] === undefined ? undefined : attachment[key]);
  const projected = losslessJson({
    // `id` is not part of ImageAttachmentRef; it is kept only because the acceptance fake service
    // exposes it (P16 asserts on it). Real stores provide attachmentId/mediaType/bytes/width/height.
    id: pick('id'), attachmentId: pick('attachmentId'), mediaType: pick('mediaType'),
    bytes: pick('bytes'), width: pick('width'), height: pick('height'), name: pick('name'),
    originalDimensions: pick('originalDimensions'),
    // Only projected when the store exposes it: capture evidence compares the attachment's digest
    // with the captured bytes to tell "same bytes" from "normalized/re-encoded".
    sha256: pick('sha256'),
  });
  return projected.attachmentId || projected.id ? projected : undefined;
}

/* ---------------------------------------------------------------------------------------------
 * P0 capture infrastructure (docs/capture-p0.md): the browser_screenshot evidence pipeline.
 *
 * One CDP path only: Page.captureScreenshot with a document-CSS clip. The bytes CDP returned are
 * the bytes that get validated, hashed, delivered to the model and written to disk — no re-encode,
 * no resize, no second capture. PNG structure / size / blankness are pure functions from
 * capture-p0.js; this file only orchestrates CDP, the workspace path and attachment comparison.
 * ------------------------------------------------------------------------------------------- */

/** Closed warning vocabulary: deduplicated, order preserving, never silently dropped. */
const CAPTURE_WARNING_VOCABULARY = Object.freeze([
  'content_uniform', 'content_transparent', 'model_image_downscaled', 'attachment_reencoded',
  'blank_check_skipped', 'capture_file_unavailable', 'attachment_unavailable', 'capture_beyond_viewport',
]);

function addCaptureWarning(warnings, code) {
  if (!CAPTURE_WARNING_VOCABULARY.includes(code)) {
    throw new BrowserError('INTERNAL', '未登记的截图警告码：' + code);
  }
  if (!warnings.includes(code)) warnings.push(code);
  return warnings;
}

/* ---------------------------------------------------------------------------------------------
 * Shared viewport (docs/viewport-control.md §3, Lead freeze 2026-11-01)
 *
 * One authoritative `view` per Runtime: `{x,y,width,height,scale,source,revision}` in document CSS
 * px. The GUI (authenticated same-origin) and the Agent tool read/write the same object; the top
 * level `viewport={width,height}` is a read-only alias of `view.width/height`.
 *
 * `mode` is DERIVED from the final width/height (never an independent selection that can drift).
 * `source` records who last changed the content (default/gui/agent/page), `revision` is monotonic
 * and only moves when content actually changed (a same-value set or a poll never bumps it).
 *
 * `scale` is the manual display scale (0.1–2.0 = 10–200%) and also the DEFAULT density of a
 * screenshot that does not pass an explicit scale. It is NOT devicePixelRatio, NOT page zoom and
 * NOT device emulation: `deviceScaleFactor` stays 1 and no page zoom is ever sent.
 * ------------------------------------------------------------------------------------------- */

/** The four GUI presets (docs/viewport-control.md §3.1); 1280×800 derives `custom`. */
const VIEW_PRESETS = Object.freeze({
  wide: Object.freeze({ width: 1920, height: 1080 }),
  landscape: Object.freeze({ width: 1024, height: 768 }),
  tablet: Object.freeze({ width: 768, height: 1024 }),
  phone: Object.freeze({ width: 393, height: 852 }),
});

const VIEW_LIMITS = Object.freeze({
  width: Object.freeze([200, 4096]),
  height: Object.freeze([200, 4096]),
  scroll: Object.freeze([0, 10000000]),
  scale: Object.freeze([0.1, 2]),
  default: Object.freeze({ width: 1280, height: 800, x: 0, y: 0, scale: 1 }),
  /** Contract §3.2: at most one metrics read every 200ms while a viewer is attached. */
  scrollPollMinMs: 200,
  /** Cached observation older than this is reported stale (never silently "fresh"). */
  staleAfterMs: 1000,
  /** set() waits two frames and at most this long for a stable readback. */
  settleMaxMs: 1000,
});

/** Fields a `view` patch may carry; `mode` expands to width/height and is never stored. */
const VIEW_FIELDS = Object.freeze(['mode', 'x', 'y', 'width', 'height', 'scale']);

/** Derived mode name for a final width/height pair. */
function viewModeFor(width, height) {
  for (const [mode, size] of Object.entries(VIEW_PRESETS)) {
    if (width === size.width && height === size.height) return mode;
  }
  return 'custom';
}

/**
 * Pure pre-flight for `browser_viewport` (docs/viewport-control.md §7): no browser, no CDP, no file.
 *
 * Rejects unknown fields, an illegal action, `get` with any other field, an empty patch, a
 * `mode`+width/height conflict, non-finite/non-integer/out-of-range numbers. A rejected call must
 * cost neither a browser start nor a page change (contract §7.1 INVALID_ARGUMENT).
 */
function normalizeViewportRequest(args) {
  const input = args && typeof args === 'object' && !Array.isArray(args) ? args : {};
  for (const key of Object.keys(input)) {
    if (!['action', ...VIEW_FIELDS, 'expectedRevision'].includes(key)) {
      throw new BrowserError('INVALID_ARGUMENT', 'browser_viewport 不接受未知字段 ' + key, {
        field: key, allowed: ['action', ...VIEW_FIELDS, 'expectedRevision'],
      });
    }
  }
  const action = input.action;
  if (action !== 'get' && action !== 'set') {
    throw new BrowserError('INVALID_ARGUMENT', 'action 只能是 get 或 set', {
      field: 'action', valueType: typeof action,
    });
  }
  if (action === 'get') {
    const extra = ['action', ...VIEW_FIELDS, 'expectedRevision']
      .filter((key) => key !== 'action' && input[key] !== undefined);
    if (extra.length) {
      throw new BrowserError('INVALID_ARGUMENT', 'action=get 是只读缓存诊断，不接受其他字段', { fields: extra });
    }
    return { action: 'get', patch: null, requested: null, expectedRevision: null };
  }
  const patch = {};
  if (input.mode !== undefined) {
    if (typeof input.mode !== 'string' || !Object.prototype.hasOwnProperty.call(VIEW_PRESETS, input.mode)) {
      throw new BrowserError('INVALID_ARGUMENT', 'mode 只能是 wide/landscape/tablet/phone（custom 只作为派生返回值）', {
        field: 'mode', valueType: typeof input.mode, allowed: Object.keys(VIEW_PRESETS),
      });
    }
    patch.mode = input.mode;
  }
  for (const key of ['x', 'y']) {
    if (input[key] === undefined) continue;
    const value = input[key];
    if (typeof value !== 'number' || !Number.isFinite(value)) {
      throw new BrowserError('INVALID_ARGUMENT', `${key} 必须是有限数字（文档 CSS 像素）`, {
        field: key, valueType: Array.isArray(value) ? 'array' : typeof value,
      });
    }
    if (value < VIEW_LIMITS.scroll[0] || value > VIEW_LIMITS.scroll[1]) {
      throw new BrowserError('INVALID_ARGUMENT', `${key} 超出允许范围`, {
        field: key, min: VIEW_LIMITS.scroll[0], max: VIEW_LIMITS.scroll[1], value,
      });
    }
    patch[key] = value;
  }
  for (const key of ['width', 'height']) {
    if (input[key] === undefined) continue;
    const value = input[key];
    if (typeof value !== 'number' || !Number.isFinite(value) || !Number.isInteger(value)) {
      throw new BrowserError('INVALID_ARGUMENT', `${key} 必须是整数（不接受小数或字符串）`, {
        field: key, valueType: Array.isArray(value) ? 'array' : typeof value,
      });
    }
    if (value < VIEW_LIMITS.width[0] || value > VIEW_LIMITS.width[1]) {
      throw new BrowserError('INVALID_ARGUMENT', `${key} 超出允许范围`, {
        field: key, min: VIEW_LIMITS.width[0], max: VIEW_LIMITS.width[1], value,
      });
    }
    patch[key] = value;
  }
  if (input.scale !== undefined) {
    const value = input.scale;
    if (typeof value !== 'number' || !Number.isFinite(value)) {
      throw new BrowserError('INVALID_ARGUMENT', 'scale 必须是有限数字（0.1–2，即 10–200%）', {
        field: 'scale', valueType: Array.isArray(value) ? 'array' : typeof value,
      });
    }
    if (value < VIEW_LIMITS.scale[0] || value > VIEW_LIMITS.scale[1]) {
      throw new BrowserError('INVALID_ARGUMENT', 'scale 超出允许范围（0.1–2，即 10–200%）', {
        field: 'scale', min: VIEW_LIMITS.scale[0], max: VIEW_LIMITS.scale[1], value,
      });
    }
    patch.scale = value;
  }
  if (patch.mode !== undefined && (patch.width !== undefined || patch.height !== undefined)) {
    throw new BrowserError('INVALID_ARGUMENT', 'mode 与 width/height 不能同时给出（预设本身已包含宽高）', {
      fields: ['mode', 'width', 'height'],
    });
  }
  if (Object.keys(patch).length === 0) {
    throw new BrowserError('INVALID_ARGUMENT', 'action=set 至少需要一个 view 字段（mode/x/y/width/height/scale）', {
      fields: [...VIEW_FIELDS],
    });
  }
  let expectedRevision = null;
  if (input.expectedRevision !== undefined) {
    const value = input.expectedRevision;
    if (typeof value !== 'number' || !Number.isSafeInteger(value) || value < 0) {
      throw new BrowserError('INVALID_ARGUMENT', 'expectedRevision 必须是非负安全整数', {
        field: 'expectedRevision', valueType: Array.isArray(value) ? 'array' : typeof value,
      });
    }
    expectedRevision = value;
  }
  return { action: 'set', patch, requested: { ...patch }, expectedRevision };
}

/**
 * Expand a validated patch: `mode` becomes its preset width/height, everything else passes through.
 *
 * A preset only supplies width/height: an `x`/`y`/`scale` given in the SAME patch is legal (only
 * `mode` + `width`/`height` is rejected by the validator) and must not be dropped. `mode` itself
 * never enters the runtime patch — it is derived from the final size.
 */
function expandViewPatch(patch) {
  if (patch && patch.mode !== undefined) {
    const { mode, ...rest } = patch;
    const preset = VIEW_PRESETS[mode];
    return { ...rest, width: preset.width, height: preset.height };
  }
  return { ...patch };
}

/**
 * Pure pre-flight for browser_screenshot: no browser, no filesystem, no capture.
 *
 * Runs before anything that could start Chromium so a rejected argument costs nothing.
 * `scale` must be a finite number in the continuous range [0.1,4] (fractions such as 1.11 are
 * legal; the output size is round(css x scale)). **Omitted is not 1**: `scale: null` is returned
 * and the caller resolves it from the shared `view.scale` inside the call (docs/viewport-control.md
 * §6.1). `region` is a document-CSS rectangle with four finite numbers and width/height >= 1;
 * `out` is an optional relative .png path.
 */
function normalizeCaptureRequest(args) {
  const input = args && typeof args === 'object' && !Array.isArray(args) ? args : {};
  let scale = null;
  if (input.scale !== undefined && input.scale !== null) {
    if (typeof input.scale !== 'number' || !Number.isFinite(input.scale)) {
      throw new BrowserError('INVALID_ARGUMENT', 'scale 必须是有限数字（连续范围 0.1–4）', {
        field: 'scale', valueType: Array.isArray(input.scale) ? 'array' : typeof input.scale,
      });
    }
    if (input.scale < CAPTURE_LIMITS.scaleMin || input.scale > CAPTURE_LIMITS.scaleMax) {
      throw new BrowserError('INVALID_ARGUMENT', 'scale 超出允许范围（连续 0.1–4，可用小数）', {
        field: 'scale', min: CAPTURE_LIMITS.scaleMin, max: CAPTURE_LIMITS.scaleMax, value: input.scale,
      });
    }
    scale = input.scale;
  }
  let region = null;
  if (input.region !== undefined && input.region !== null) {
    const raw = input.region;
    if (typeof raw !== 'object' || Array.isArray(raw)) {
      throw new BrowserError('INVALID_ARGUMENT', 'region 必须是 {x,y,width,height} 对象（文档 CSS 像素）', { field: 'region' });
    }
    const rect = {};
    for (const key of ['x', 'y', 'width', 'height']) {
      const value = raw[key];
      if (typeof value !== 'number' || !Number.isFinite(value)) {
        throw new BrowserError('INVALID_ARGUMENT', `region.${key} 必须是有限数字`, {
          field: 'region.' + key, valueType: typeof value,
        });
      }
      rect[key] = value;
    }
    if (rect.width < 1 || rect.height < 1) {
      throw new BrowserError('INVALID_ARGUMENT', 'region.width/height 必须 ≥ 1 CSS 像素', {
        field: 'region', width: rect.width, height: rect.height,
      });
    }
    region = rect;
  }
  let out = null;
  if (input.out !== undefined && input.out !== null) {
    if (typeof input.out !== 'string') {
      throw new BrowserError('INVALID_ARGUMENT', 'out 必须是工作区相对的 .png 路径字符串', { field: 'out', valueType: typeof input.out });
    }
    out = input.out;
  }
  let persist = false;
  if (input.persist !== undefined && input.persist !== null) {
    if (typeof input.persist !== 'boolean') {
      throw new BrowserError('INVALID_ARGUMENT', 'persist 必须是布尔值（true = 持久留存到工作区，false/省略 = 暂存目录）', {
        field: 'persist', valueType: Array.isArray(input.persist) ? 'array' : typeof input.persist,
      });
    }
    persist = input.persist;
  }
  return { scale, region, out, persist };
}

/** Pixel budget, judged before any CDP screenshot: Chrome must never be asked for more. */
function assertCaptureBudget(rect, scale) {
  const expected = expectedPixelSize({ width: rect.width, height: rect.height, scale, deviceScaleFactor: 1 });
  // A small region at a low scale can round to 0 px on an axis (docs/viewport-control.md §6.2):
  // refuse before dispatch instead of asking Chrome for an impossible clip.
  if (!hasPositiveOutputSize(expected)) {
    throw new BrowserError('INVALID_ARGUMENT', '截图输出尺寸会舍入到 0 像素（请提高 scale 或 region 尺寸）', {
      reason: 'empty-output-dimensions',
      expected: { width: expected.width, height: expected.height },
      requested: { region: { x: rect.x, y: rect.y, width: rect.width, height: rect.height }, scale },
    });
  }
  const pixels = expected.width * expected.height;
  if (pixels > CAPTURE_LIMITS.maxOutputPixels) {
    throw new BrowserError('CAPTURE_TOO_LARGE', '截图期望像素超过上限', {
      expected: { width: expected.width, height: expected.height, pixels },
      max: CAPTURE_LIMITS.maxOutputPixels,
      requested: { region: { x: rect.x, y: rect.y, width: rect.width, height: rect.height }, scale },
    });
  }
  return expected;
}

/**
 * Capture output root: `DSH_UI_TESTING_CAPTURE_DIR` (absolute) wins, otherwise the calling
 * session's own workspace directory. Never `process.cwd()` and never an exec-meta guess.
 */
/** Reject unknown tool fields (docs/network-p0.md §2: `additionalProperties:false`). */
function assertKnownKeys(value, allowed, label) {
  if (value === undefined || value === null) return {};
  if (typeof value !== 'object' || Array.isArray(value)) throw new BrowserError('NET_INVALID_ARGUMENT', label + ' 必须是对象');
  for (const key of Object.keys(value)) {
    if (!allowed.includes(key)) {
      throw new BrowserError('NET_INVALID_ARGUMENT', label + ' 含未知字段 ' + key, { field: key, allowed: [...allowed] });
    }
  }
  return value;
}

/** The configured persistent capture root (env override), or null when unset/blank. */
function captureEnvRoot() {
  const override = process.env.DSH_UI_TESTING_CAPTURE_DIR;
  return typeof override === 'string' && override.trim() !== '' ? override.trim() : null;
}

/** Persistent root: env wins, otherwise the calling session's own workspace directory. */
function captureRootFor(exec) {
  const envRoot = captureEnvRoot();
  if (envRoot !== null) return { root: envRoot, source: 'env' };
  const cwd = exec && exec.agent && exec.agent.session && exec.agent.session.header
    ? exec.agent.session.header.cwd
    : undefined;
  if (typeof cwd === 'string' && cwd.trim() !== '') return { root: cwd, source: 'workspace' };
  return { root: null, source: 'unknown' };
}

/**
 * Where a capture is written (task-6 contract).
 *
 * persistent  = the caller asked to keep the file: `out` given, `persist:true`, or a configured
 *               DSH_UI_TESTING_CAPTURE_DIR. Root is the env override (absolute; never falls back)
 *               or the calling session's workspace; an unknown root is OUTPUT_PATH_INVALID.
 * staging     = the default. The file goes to the plugin instance's own temporary root and is
 *               removed when the plugin is disposed; it is delivery evidence, not a workspace file.
 */
/**
 * Web P0 child-target coverage, measured on this build (real headless Chromium + /web-network.html).
 * Kept as one constant so both `capabilities.network.limits.network.subTargets` and the flat
 * `limits.network.subTargets` report exactly the same facts.
 */
const NETWORK_SUBTARGETS = Object.freeze({
  workers: 'page-attached',
  shared_worker: 'not-collected',
  service_worker: 'not-collected',
  oopif: 'partial',
  partial: true,
  reason: 'attaching a service_worker target pauses it at start (waitForDebuggerOnStart) and breaks serviceWorker.register()/controller, so it is refused; shared_worker is not attached by a page-level auto-attach in this build; popup targets stay blocked; cross-site OOPIF not separately verified',
});

const CAPTURE_PERSIST_RULES = Object.freeze(['out', 'persist:true', 'DSH_UI_TESTING_CAPTURE_DIR']);

/**
 * Read the bundled ui-testing SKILL.md and turn it into a runtime skill registration.
 * The body is the single source of truth; the description comes from frontmatter when it is a
 * single-line scalar, otherwise a reviewed constant is used. Returns undefined only when the
 * skill file is absent (a tools-only deployment stays usable).
 */
function readBundledSkill() {
  const file = join(SKILL_DIR, 'SKILL.md');
  let raw;
  try {
    raw = readFileSync(file, 'utf8');
  } catch {
    return undefined;
  }
  const frontmatter = /^---\r?\n([\s\S]*?)\r?\n---(?:\r?\n|$)/u.exec(raw);
  if (!frontmatter) throw new Error('skills/ui-testing/SKILL.md 缺少 YAML frontmatter');
  const singleLine = /^description:\s*(?!>)(.+)$/m.exec(frontmatter[1]);
  return {
    name: SKILL_NAME,
    description: singleLine ? singleLine[1].trim() : SKILL_FALLBACK_DESCRIPTION,
    source: 'bundled',
    content: raw.slice(frontmatter[0].length).trim(),
    resourceBase: { kind: 'directory', path: SKILL_DIR.split(sep).join('/') },
    invocation: { modelInvocable: true, userInvocable: true },
  };
}

/* ---------------------------------------------------------------------------------------------
 * Workspace isolation: shared BrowserHost (one Chromium + one temporary profile per plugin
 * lifecycle) with one independent page target per workspace Runtime.
 *
 * The browser-level CDP connection is used for target lifecycle and popup interception only.
 * Every Runtime owns a page-level CDP connection: page commands, Fetch interception, screencast
 * frames and their ACKs all travel on that connection, so one page can never ack another page's
 * frame. `Target.attachedToTarget` (auto-attach) is a browser-level session, `targetId` names the
 * page, and `Page.screencastFrame.params.sessionId` is yet another id — never conflate them.
 *
 * Owned-target state machine:
 *   ownedTargets    targetId -> { runtime, generation }  pages this host created/reused
 *   autoAttached    browser sessionId -> targetId        auto-attach sessions seen so far
 *   pendingAttach   targetId -> sessionId                attach events parked before createTarget resolved
 *   closingTargets  targetIds whose closeTarget is in flight
 * An attach event that arrives while `creating > 0` may belong to our own in-flight createTarget
 * (whose targetId we do not know yet), so it is parked — never classified as a popup — and settled
 * by the create that owns it. Everything else is a popup and is blocked before it resumes.
 * ------------------------------------------------------------------------------------------- */
const MAX_PAGES_DEFAULT = 8;
const IDLE_MS_DEFAULT = 600000;
/** A viewer is only "visible" while the panel keeps posting metrics (WS liveness alone can leak). */
const VIEWER_TTL_MS = 15000;
/** Bounded cold-entry cache: at most maxPages page entries + this many idle scope entries. */
const MAX_ENTRIES_DEFAULT = 32;
/** Contract defaults, exported so acceptance tests can assert them even when env overrides. */
export const WORKSPACE_ISOLATION_DEFAULTS = Object.freeze({ maxPages: MAX_PAGES_DEFAULT, idleMs: IDLE_MS_DEFAULT, viewerTtlMs: VIEWER_TTL_MS });
/** Bounded wait for a freshly created target to show up in /json/list with its debugger URL. */
const TARGET_WS_TIMEOUT_MS = 10000;
/** Host-owned createTarget lifetime: the response must still be adopted if the caller aborts. */
const PAGE_CREATE_TIMEOUT_MS = 30000;

const delay = (ms) => new Promise((resolve) => { setTimeout(resolve, ms); });

function envPositiveInt(name, fallback) {
  const raw = process.env[name];
  if (raw === undefined || raw === '') return fallback;
  const value = Number(raw);
  return Number.isFinite(value) && value > 0 ? Math.floor(value) : fallback;
}

function sha256Short(value, length = 16) {
  return createHash('sha256').update(String(value)).digest('hex').slice(0, length);
}

/**
 * One headless Chromium + temporary profile for the whole plugin, with N independent page targets.
 *
 * Popup interception is unchanged: extra page targets that are not owned by a Runtime are paused
 * via auto-attach, have Fetch fail-all installed, then are resumed and closed.
 */
export class BrowserHost {
  constructor(log) {
    this.log = log;
    this.proc = undefined;
    this.profileDir = undefined;
    this.port = 0;
    this.browserCdp = undefined;
    this.starting = undefined;
    this.closing = undefined;
    /** Bumped on every spawn/close; page creation and event handlers are bound to one value. */
    this.generation = 0;
    this.cleanupError = null;
    this.ownedTargets = new Map();
    this.autoAttached = new Map();
    this.pendingAttach = new Map();
    this.pendingCreates = 0;
    this.closingTargets = new Set();
    this.popupSessions = new Set();
    this.initialTargetId = undefined;
  }

  get pageCount() { return this.ownedTargets.size; }

  get running() { return Boolean(this.browserCdp && !this.browserCdp.closed); }

  /**
   * Ensure the browser process/CDP is up. Mutually exclusive with close(): a caller that arrives
   * while the host is closing waits for it and then starts a fresh generation.
   */
  async ensureBrowser(signal) {
    for (;;) {
      if (this.closing) { try { await this.closing; } catch { /* closed */ } continue; }
      if (this.browserCdp && !this.browserCdp.closed) return this.browserCdp;
      if (this.starting) return abortable(this.starting, signal);
      if (this.proc || this.profileDir) { await this.close(); continue; }
      break;
    }
    this.starting = this.#spawn(signal).finally(() => { this.starting = undefined; });
    return this.starting;
  }

  /** Create (or reuse the initial about:blank) page target and connect to it directly. */
  async createPage(runtime, signal) {
    checkAbort(signal);
    const browserCdp = await this.ensureBrowser(signal);
    const generation = this.generation;
    this.pendingCreates += 1;
    let targetId;
    try {
      if (this.initialTargetId && !this.ownedTargets.has(this.initialTargetId)) {
        // The pre-existing about:blank target may have been closed externally; reusing a dead
        // target would make the debugger-URL lookup spin until its timeout.
        let alive = false;
        try { alive = (await this.#listTargets(signal)).some((target) => target.id === this.initialTargetId); }
        catch { alive = false; }
        if (!alive) this.initialTargetId = undefined;
      }
      if (this.initialTargetId && !this.ownedTargets.has(this.initialTargetId)) {
        targetId = this.initialTargetId;
        this.initialTargetId = undefined;
      } else {
        // The Host owns this command's lifetime: a caller abort must not drop a target that
        // createTarget may still create (that would leak a paused, unknown target).
        const created = await browserCdp.send('Target.createTarget', { url: 'about:blank' }, { timeoutMs: PAGE_CREATE_TIMEOUT_MS });
        targetId = created && created.targetId;
        if (!targetId) throw new BrowserError('CDP_DISCONNECTED', 'Chromium 未返回新的 page target');
        if (signal?.aborted) {
          const abortedId = targetId;
          targetId = undefined;
          await this.#closeOwnedTarget(abortedId);
          throw new BrowserError('ABORTED', '操作已取消');
        }
      }
      if (this.closing || this.browserCdp !== browserCdp || this.generation !== generation) {
        throw new BrowserError('CDP_DISCONNECTED', '浏览器在创建页面时被关闭', {
          phase: 'createPage', generation, currentGeneration: this.generation,
          closing: Boolean(this.closing), browserChanged: this.browserCdp !== browserCdp,
          pageCount: this.pageCount, pendingCreates: this.pendingCreates,
        });
      }
      this.ownedTargets.set(targetId, { runtime, generation });
      // An attach event parked while createTarget was in flight belongs to this owned target.
      const parked = this.pendingAttach.get(targetId);
      if (parked) this.#resumeAndDetach(browserCdp, targetId, parked);
      const wsUrl = await this.#resolveTargetWsUrl(browserCdp, targetId, signal);
      const cdp = new Cdp(wsUrl);
      await cdp.connect({ signal });
      if (this.closing || this.browserCdp !== browserCdp || this.generation !== generation) {
        try { cdp.close(); } catch { /* ignore */ }
        throw new BrowserError('CDP_DISCONNECTED', '浏览器在创建页面时被关闭');
      }
      return { targetId, cdp, generation };
    } catch (error) {
      if (targetId) { try { await this.#closeOwnedTarget(targetId); } catch { /* ignore */ } }
      throw error;
    } finally {
      this.pendingCreates -= 1;
      // Never leave a parked target paused forever: once no create is in flight, anything still
      // parked is not ours and is handled as a popup.
      if (this.pendingCreates === 0) this.#settlePendingAttach(browserCdp);
    }
  }

  /** Close one Runtime's page target. The browser process/profile are NOT touched here. */
  async closePage(runtime, targetId) {
    if (targetId) {
      if (this.ownedTargets.has(targetId)) await this.#closeOwnedTarget(targetId);
      return;
    }
    const match = [...this.ownedTargets.entries()].find(([, value]) => value.runtime === runtime);
    if (!match) return;
    await this.#closeOwnedTarget(match[0]);
  }

  /** Close the browser process, every target and the temporary profile (idempotent). */
  close() {
    if (this.closing) return this.closing;
    this.closing = this.#doClose().finally(() => { this.closing = undefined; });
    return this.closing;
  }

  async #doClose() {
    this.log('browser host closing (generation ' + this.generation + ')');
    const browserCdp = this.browserCdp;
    // Detach first: concurrent ensure() must not reuse this closing generation.
    this.browserCdp = undefined;
    this.generation += 1;
    this.initialTargetId = undefined;
    const targetIds = [...this.ownedTargets.keys()];
    this.ownedTargets.clear();
    this.autoAttached.clear();
    this.pendingAttach.clear();
    this.popupSessions.clear();
    if (browserCdp && !browserCdp.closed) {
      for (const targetId of targetIds) {
        try { await browserCdp.send('Target.closeTarget', { targetId }, { timeoutMs: 1000 }); } catch { /* ignore */ }
      }
      try { browserCdp.close(); } catch { /* ignore */ }
    }
    const proc = this.proc;
    this.proc = undefined;
    const dir = this.profileDir;
    this.profileDir = undefined;
    this.port = 0;
    if (proc) {
      try { proc.kill('SIGTERM'); } catch { /* ignore */ }
      const exited = await waitForExit(proc, 1200);
      if (!exited) {
        try { proc.kill('SIGKILL'); } catch { /* ignore */ }
        await waitForExit(proc, 500);
      }
    }
    if (dir) await this.#removeProfileDir(dir);
  }

  async #spawn(signal) {
    // Resolve first: a missing browser must fail before a profile directory is created.
    const chromeBin = resolveChromeExecutable();
    const profileDir = await mkdtemp(join(tmpdir(), 'dsh-ui-testing-'));
    this.profileDir = profileDir;
    this.generation += 1;
    const generation = this.generation;
    let proc;
    try {
      proc = spawn(chromeBin, [
        '--headless=new',
        '--remote-debugging-port=0',
        `--user-data-dir=${profileDir}`,
        '--no-first-run',
        '--no-default-browser-check',
        '--disable-gpu',
        '--hide-scrollbars',
        '--mute-audio',
        '--disable-background-timer-throttling',
        '--disable-renderer-backgrounding',
        // Keep hidden/occluded page targets compositing: without this, a non-front page stops
        // emitting screencast frames, so only one workspace preview would ever update.
        '--disable-backgrounding-occluded-windows',
        '--disable-features=CalculateNativeWinOcclusion',
        '--window-size=1280,800',
        'about:blank',
      ], { stdio: ['ignore', 'ignore', 'pipe'] });
      this.proc = proc;
      let spawnError;
      proc.on('error', (error) => { spawnError = error; });
      proc.stderr.on('data', (chunk) => {
        const text = String(chunk);
        if (/error|fatal/i.test(text)) this.log('chrome: ' + text.trim().slice(0, 300));
      });
      proc.on('exit', () => {
        if (this.proc !== proc) return;
        this.proc = undefined;
        this.browserCdp = undefined;
      });

      const devtoolsFile = join(profileDir, 'DevToolsActivePort');
      let port = 0;
      for (let attempt = 0; attempt < 100; attempt += 1) {
        checkAbort(signal);
        if (spawnError || proc.exitCode !== null) {
          if (spawnError && ['ENOENT', 'EACCES'].includes(spawnError.code)) {
            throw new BrowserError('UNSUPPORTED', `Chrome 可执行文件无法启动（${spawnError.code}）：${chromeBin}`, { binary: chromeBin, phase: 'spawn' });
          }
          throw new BrowserError('CDP_DISCONNECTED', spawnError?.message || 'Chromium 启动进程提前退出');
        }
        try {
          const text = await readFile(devtoolsFile, 'utf8');
          port = Number(text.split('\n')[0]);
          if (port) break;
        } catch { /* not ready yet */ }
        await delay(100);
      }
      if (!port) throw new BrowserError('CDP_TIMEOUT', 'Chromium 未在预期时间内启动（DevToolsActivePort 不存在）', { binary: chromeBin, phase: 'startup' });
      this.port = port;

      const version = await fetch(`http://127.0.0.1:${port}/json/version`, { signal }).then((response) => response.json());
      const browserCdp = new Cdp(version.webSocketDebuggerUrl);
      await browserCdp.connect({ signal });
      if (this.generation !== generation || this.closing) {
        try { browserCdp.close(); } catch { /* ignore */ }
        throw new BrowserError('CDP_DISCONNECTED', '浏览器在启动过程中被关闭');
      }
      this.browserCdp = browserCdp;
      browserCdp.on((message) => {
        if (this.browserCdp !== browserCdp) return;
        this.#onBrowserEvent(browserCdp, message);
      });
      // Record the pre-existing about:blank target BEFORE enabling auto-attach: setAutoAttach
      // also attaches to existing targets, and an attach event for the initial page must never be
      // classified as a popup (that would block/close the page we are about to reuse).
      this.initialTargetId = await this.#findInitialPage(signal);
      await browserCdp.send('Target.setAutoAttach', {
        autoAttach: true, waitForDebuggerOnStart: true, flatten: true,
        filter: [{ type: 'page', exclude: false }],
      }, { signal });
      this.log(`chromium ready on devtools port ${port} (generation ${generation})`);
      return browserCdp;
    } catch (error) {
      try { this.browserCdp?.close(); } catch { /* ignore */ }
      this.browserCdp = undefined;
      this.initialTargetId = undefined;
      this.port = 0;
      if (proc && proc.exitCode === null) {
        try { proc.kill('SIGKILL'); } catch { /* ignore */ }
      }
      this.proc = undefined;
      this.profileDir = undefined;
      if (proc) await waitForExit(proc, 500);
      // profileDir is the exact absolute directory returned by mkdtemp above.
      await this.#removeProfileDir(profileDir);
      throw error;
    }
  }

  async #listTargets(signal) {
    const list = await fetch(`http://127.0.0.1:${this.port}/json/list`, { signal }).then((response) => response.json());
    return Array.isArray(list) ? list : [];
  }

  async #findInitialPage(signal) {
    try {
      const pages = (await this.#listTargets(signal)).filter((target) => target.type === 'page' && typeof target.id === 'string');
      return pages.length ? pages[0].id : undefined;
    } catch {
      return undefined;
    }
  }

  /**
   * Resolve the exact owned target's page-level debugger URL. Never "the first page target":
   * with several workspaces alive that would silently attach one workspace to another's page.
   */
  async #resolveTargetWsUrl(browserCdp, targetId, signal) {
    const deadline = Date.now() + TARGET_WS_TIMEOUT_MS;
    for (;;) {
      checkAbort(signal);
      if (this.browserCdp !== browserCdp || this.closing) throw new BrowserError('CDP_DISCONNECTED', '浏览器在创建页面时被关闭');
      try {
        const list = await this.#listTargets(signal);
        const target = list.find((entry) => entry.id === targetId);
        if (target && typeof target.webSocketDebuggerUrl === 'string' && target.webSocketDebuggerUrl) {
          return target.webSocketDebuggerUrl;
        }
      } catch (error) {
        if (error && error.name === 'AbortError') throw new BrowserError('ABORTED', '操作已取消');
      }
      if (Date.now() >= deadline) throw new BrowserError('CDP_TIMEOUT', '无法解析新 page target 的调试地址');
      await delay(50);
    }
  }

  #onBrowserEvent(browserCdp, message) {
    if (message.method === 'Fetch.requestPaused' && this.popupSessions.has(message.sessionId)) {
      browserCdp.send('Fetch.failRequest', { requestId: message.params.requestId, errorReason: 'BlockedByClient' }, { sessionId: message.sessionId }).catch(() => {});
      return;
    }
    if (message.method === 'Target.detachedFromTarget') {
      this.popupSessions.delete(message.params.sessionId);
      for (const [sessionId, targetId] of this.autoAttached) {
        if (sessionId === message.params.sessionId) this.autoAttached.delete(sessionId);
        if (targetId === message.params.targetId) this.autoAttached.delete(sessionId);
      }
      return;
    }
    if (message.method !== 'Target.attachedToTarget') return;
    const { targetInfo, sessionId } = message.params;
    const targetId = targetInfo.targetId;
    this.autoAttached.set(sessionId, targetId);
    if (targetInfo.type !== 'page') {
      this.#resumeAndDetach(browserCdp, targetId, sessionId);
      return;
    }
    if (this.ownedTargets.has(targetId) || targetId === this.initialTargetId) {
      this.#resumeAndDetach(browserCdp, targetId, sessionId);
      return;
    }
    if (this.pendingCreates > 0) {
      // Might be the target of our own in-flight createTarget: park it paused; the owning create
      // adopts it, or the last create settles it as a popup. Never resume an unknown target.
      this.pendingAttach.set(targetId, sessionId);
      return;
    }
    this.#blockPopup(browserCdp, targetId, sessionId);
  }

  #resumeAndDetach(browserCdp, targetId, sessionId) {
    this.pendingAttach.delete(targetId);
    browserCdp.send('Runtime.runIfWaitingForDebugger', {}, { sessionId })
      .then(() => browserCdp.send('Target.detachFromTarget', { sessionId }))
      .catch(() => {});
  }

  /** Install fail-all interception BEFORE resuming, then close the extra page target. */
  #blockPopup(browserCdp, targetId, sessionId) {
    this.log('blocking popup target ' + targetId);
    this.pendingAttach.delete(targetId);
    this.popupSessions.add(sessionId);
    browserCdp.send('Fetch.enable', { patterns: [{ urlPattern: '*' }] }, { sessionId })
      .then(() => browserCdp.send('Runtime.runIfWaitingForDebugger', {}, { sessionId }))
      .then(() => {
        const timer = setTimeout(() => browserCdp.send('Target.closeTarget', { targetId }).catch(() => {}), 100);
        timer.unref?.();
      })
      .catch(() => browserCdp.send('Target.closeTarget', { targetId }).catch(() => {}));
  }

  #settlePendingAttach(browserCdp) {
    for (const [targetId, sessionId] of [...this.pendingAttach]) {
      if (this.ownedTargets.has(targetId)) continue;
      this.#blockPopup(browserCdp, targetId, sessionId);
    }
  }

  async #closeOwnedTarget(targetId) {
    this.log('closing owned target ' + targetId + ' runtime=' + (this.ownedTargets.get(targetId)?.runtime?.scope?.id || '?'));
    this.ownedTargets.delete(targetId);
    this.closingTargets.add(targetId);
    const browserCdp = this.browserCdp;
    try {
      if (browserCdp && !browserCdp.closed) await browserCdp.send('Target.closeTarget', { targetId }, { timeoutMs: 2000 });
    } catch { /* target already gone */ }
    this.closingTargets.delete(targetId);
  }

  /**
   * Remove one exact mkdtemp profile directory with a bounded retry. A cleanup failure must never
   * make close() fail, but it must not be silent either.
   */
  async #removeProfileDir(dir) {
    if (!dir) return;
    try {
      await rm(dir, { recursive: true, force: true, maxRetries: PROFILE_RM_RETRIES, retryDelay: PROFILE_RM_RETRY_DELAY_MS });
      this.cleanupError = null;
    } catch (error) {
      const message = `[PROFILE_CLEANUP_FAILED] 临时 profile 删除失败：${redactText(String((error && error.message) || error))}`;
      this.cleanupError = message;
      this.log(message);
    }
  }
}

/* ---------------------------------------------------------------------------------------------
 * Scope descriptors. Only opaque ids leave the Host: `workspaceId` is the one stable public id,
 * absolute paths are hashed and never exposed in scope objects, tool values or frame metadata.
 * ------------------------------------------------------------------------------------------- */
/* ---------------------------------------------------------------------------------------------
 * Web T2 (structured GUI) — contract: docs/t2-structured-gui.md
 *
 * CDP only: no Playwright, no new dependency. A ref (`e1`, `e2`, …) is a *Runtime-scoped* pointer at
 * one element. Numbers grow monotonically and are never recycled; an entry remembers the snapshot
 * that minted it (minted provenance) and is re-verified inside the page before every action, so an
 * action can never silently hit a different element.
 * ------------------------------------------------------------------------------------------- */
const T2_LIMITS = Object.freeze({
  protocolVersion: 1,
  snapshotDefaultMaxNodes: 500, snapshotMaxNodes: 2000,
  snapshotDefaultDepth: 12, snapshotMaxDepth: 32,
  treeBytes: 131072, snapshotBytes: 524288, evidenceBytes: 262144,
  nameBytes: 256, textBytes: 512, roleBytes: 64, titleBytes: 512, urlBytes: 2048,
  selectorBytes: 2048, refBytes: 32, waitValueBytes: 4096,
  formFields: 20, formTextBytes: 65536, comboOptionBytes: 256, comboValues: 20,
  waitDefaultTimeoutMs: 5000, waitMaxTimeoutMs: 30000,
  waitDefaultPollMs: 100, waitMinPollMs: 50, waitMaxPollMs: 1000,
  scrollAmount: 400, scrollMaxAmount: 10000,
  targetMax: 20, networkEntries: 20, networkErrorBytes: 256,
  maxRefs: 2000, boxConcurrency: 8, prepareMs: 1000,
});
const T2_MOUSE_BUTTONS = Object.freeze({ left: 1, right: 2, middle: 4 });
/**
 * Fixed recovery hint for a scroll target that cannot be driven right now (contract §4.3).
 *
 * `browser_scroll` deliberately does NOT scroll the target (or its ancestors) into view — that is
 * the click/type preparation semantics, not a scroll tool's. The caller scrolls the document with a
 * target-less call and retries. The text is a constant so it never leaks a selector literal.
 */
const T2_SCROLL_VIEWPORT_HINT = '先用不带 ref/selector 的 browser_scroll 滚动文档，使目标进入视口后重试';
const T2_FORM_KINDS = Object.freeze(['textbox', 'checkbox', 'radio', 'combobox', 'slider']);
const T2_WAIT_STATE_KEYS = Object.freeze(['visible', 'enabled', 'checked', 'valueEquals']);
/**
 * AX roles that get a ref in the snapshot. Only nodes with a main-document `backendDOMNodeId` are
 * eligible; StaticText/inline text and virtual AX nodes never are (contract §3.1).
 */
const T2_REF_ROLES = new Set([
  'button', 'link', 'textbox', 'searchbox', 'checkbox', 'radio', 'combobox', 'listbox', 'option',
  'slider', 'spinbutton', 'switch', 'tab', 'treeitem', 'gridcell', 'menuitem', 'menuitemcheckbox',
  'menuitemradio', 'togglebutton', 'disclosuretriangle', 'scrollbar', 'textfield',
]);
/** Generic-ish AX containers: dropped when empty, collapsed when they have exactly one child. */
const T2_CONTAINER_ROLES = new Set(['generic', 'none', 'GenericContainer', 'Section', 'group', 'paragraph']);

/** Collapse whitespace (incl. NBSP / zero-width) — snapshot text never carries layout whitespace. */
function t2Flatten(value) {
  return String(value === undefined || value === null ? '' : value)
    .replace(/[\u200b-\u200f\u2060\ufeff]/gu, '')
    .replace(/\s+/gu, ' ')
    .trim();
}

/**
 * Collapse internal whitespace for a text fragment while KEEPING its edge spaces.
 *
 * Fragment boundaries are meaningful: `Alpha` + ` ` + `Beta` must still read as "Alpha Beta" once the
 * whitespace-only nodes are dropped, so a text leaf is never trimmed here (contract §3.1.1: 顺序/空格/
 * 标点不得丢).
 */
function t2CollapseWhitespace(value) {
  return String(value === undefined || value === null ? '' : value)
    .replace(/[\u200b-\u200f\u2060\ufeff]/gu, '')
    .replace(/\s+/gu, ' ');
}

/**
 * Is this node a transparent part of the surrounding text run (no name, no ref, no state)?
 *
 * Text leaves and anonymous wrappers (`generic`, `strong`, `paragraph`, …) are transparent, so a
 * whitespace separator between them belongs to the same text run. A node that carries a name, a ref
 * or a state token starts a new run — spaces never leak across independent semantic nodes.
 */
function t2IsTextTransparent(node) {
  const role = t2AxRoleOf(node);
  if (T2_AX_TEXT_ROLES.has(role)) return true;
  const props = t2AxProps(node);
  const editable = props.get('editable');
  if (T2_REF_ROLES.has(role)) return false;
  if (role !== 'generic' && (editable === true || editable === 'richtext' || editable === 'plaintext')) return false;
  if (t2Flatten(t2AxRawName(node))) return false;
  if (t2StateTokens(props).length) return false;
  return true;
}

/**
 * Project every text leaf of a rendered tree, in document order.
 *
 * A whitespace-only text leaf is never emitted on its own line (contract §3.1.1 removes whitespace
 * text), but its single space is folded onto the *next* text representation of the same text run, so
 * reading the emitted text lines in order still reproduces the original spacing ("Alpha Beta Gamma",
 * never "AlphaBetaGamma"). Returns nodeId -> text, with `null` meaning "do not emit this node".
 */
function t2BuildTextProjection(roots, childrenOf) {
  // A text leaf is one representation: its InlineTextBox fragments are the same text, so they are
  // never walked (contract §3.1.1: StaticText → InlineTextBox 链只保留一份). A whitespace-only leaf
  // is projected as a single space — it is the separator between fragments, and dropping it would
  // turn "Alpha Beta Gamma" into "AlphaBetaGamma" — while an empty rendering is never emitted.
  const projection = new Map();
  const walk = (node) => {
    if (!node) return;
    if (node.ignored === true) {
      for (const child of childrenOf.get(node.nodeId) || []) walk(child);
      return;
    }
    const role = t2AxRoleOf(node);
    if (T2_AX_TEXT_ROLES.has(role)) {
      const text = t2CollapseWhitespace(t2AxRawText(node));
      projection.set(node.nodeId, text.trim() ? text : ' ');
      return;
    }
    for (const child of childrenOf.get(node.nodeId) || []) walk(child);
  };
  for (const root of roots) walk(root);
  return projection;
}

/**
 * Text-leaf projection: collapse internal whitespace, keep edge spaces, redact URLs, bound bytes.
 *
 * Edge spaces are the fragment separators (contract §3.1.1: 空格不得丢), so a text line is not
 * trimmed the way names are.
 */
function t2FormatTextLeaf(rawText) {
  return t2TruncateBytes(redactText(t2CollapseWhitespace(rawText)), T2_LIMITS.textBytes);
}

/** Truncate on a Unicode boundary with a `…` terminator; the limit includes the terminator. */
function t2TruncateBytes(value, maxBytes) {
  const text = String(value === undefined || value === null ? '' : value);
  if (Buffer.byteLength(text, 'utf8') <= maxBytes) return text;
  const ellipsis = '…';
  const budget = Math.max(0, maxBytes - Buffer.byteLength(ellipsis, 'utf8'));
  let out = '';
  let used = 0;
  for (const character of text) {
    const size = Buffer.byteLength(character, 'utf8');
    if (used + size > budget) break;
    out += character;
    used += size;
  }
  return out + ellipsis;
}

/** Public string projection: URL/secret redaction first, then the byte bound (contract §5.1). */
function t2Public(value, maxBytes) {
  return t2TruncateBytes(t2Flatten(redactText(t2Flatten(value))), maxBytes);
}

function t2InvalidArgument(message, details = {}) {
  return new BrowserError('INVALID_ARGUMENT', message, details);
}

function t2Object(value, name) {
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw t2InvalidArgument(`${name} 必须是普通对象`);
  return value;
}

function t2RejectUnknown(value, allowed, name) {
  for (const key of Object.keys(value)) {
    if (!allowed.includes(key)) throw t2InvalidArgument(`${name} 不接受字段：${key}`);
  }
}

function t2StringField(value, { name, maxBytes, allowEmpty = false, nullable = false }) {
  if (value === undefined || value === null) {
    if (nullable) return null;
    throw t2InvalidArgument(`${name} 必填`);
  }
  if (typeof value !== 'string') throw t2InvalidArgument(`${name} 必须是字符串`);
  if (value.includes('\u0000')) throw t2InvalidArgument(`${name} 不能包含 NUL 字符`);
  if (!allowEmpty && value.length === 0) throw t2InvalidArgument(`${name} 不能为空字符串`);
  if (Buffer.byteLength(value, 'utf8') > maxBytes) throw t2InvalidArgument(`${name} 超过 ${maxBytes} UTF-8 字节`);
  return value;
}

function t2BooleanField(value, fallback, name) {
  if (value === undefined || value === null) {
    if (fallback === undefined) throw t2InvalidArgument(`${name} 必填`);
    return fallback;
  }
  if (typeof value !== 'boolean') throw t2InvalidArgument(`${name} 必须是布尔值`);
  return value;
}

function t2IntegerField(value, fallback, min, max, name) {
  if (value === undefined || value === null) {
    if (fallback === undefined) throw t2InvalidArgument(`${name} 必填`);
    return fallback;
  }
  if (typeof value !== 'number' || !Number.isInteger(value) || Object.is(value, -0)) {
    throw t2InvalidArgument(`${name} 必须是整数（不接受小数或字符串）`);
  }
  if (value < min || value > max) throw t2InvalidArgument(`${name} 必须在 ${min}–${max} 之间`);
  return value;
}

function t2NumberField(value, fallback, min, max, name) {
  if (value === undefined || value === null) {
    if (fallback === undefined) throw t2InvalidArgument(`${name} 必填`);
    return fallback;
  }
  if (typeof value !== 'number' || !Number.isFinite(value) || Object.is(value, -0)) {
    throw t2InvalidArgument(`${name} 必须是有限数字`);
  }
  if (value < min || value > max) throw t2InvalidArgument(`${name} 必须在 ${min}–${max} 之间`);
  return value;
}

function t2ModifierList(value) {
  if (value === undefined || value === null) return [];
  if (!Array.isArray(value)) throw t2InvalidArgument('modifiers 必须是字符串数组 alt/ctrl/meta/shift');
  const names = [];
  for (const item of value) {
    if (typeof item !== 'string') throw t2InvalidArgument('modifiers 只接受字符串 alt/ctrl/meta/shift');
    const name = item.trim().toLowerCase();
    if (!Object.hasOwn(MODIFIER_BITS, name)) throw t2InvalidArgument('modifiers 只接受 alt/ctrl/meta/shift');
    if (names.includes(name)) throw t2InvalidArgument('modifiers 不能重复');
    names.push(name);
  }
  if (names.length > 4) throw t2InvalidArgument('modifiers 最多 4 项');
  return names;
}

/**
 * Parse the mutually exclusive `ref` / `selector` string pair (contract §2.1).
 *
 * These are two plain strings, not a Target object: `ref` is `^e[1-9][0-9]*$`, `selector` is a
 * non-empty native CSS selector, and callers never supply a snapshotId.
 */
function t2RefOrSelector(options, { name = '', exactlyOne = true, allowNone = false } = {}) {
  const hasRef = options.ref !== undefined && options.ref !== null;
  const hasSelector = options.selector !== undefined && options.selector !== null;
  if (hasRef && hasSelector) throw t2InvalidArgument(`${name}ref 与 selector 只能二选一`);
  if (!hasRef && !hasSelector) {
    if (allowNone || !exactlyOne) return null;
    throw t2InvalidArgument(`${name}必须提供 ref 或 selector 之一`);
  }
  if (hasRef) {
    const ref = t2StringField(options.ref, { name: `${name}ref`, maxBytes: T2_LIMITS.refBytes });
    if (!/^e[1-9][0-9]*$/.test(ref)) throw t2InvalidArgument(`${name}ref 必须匹配 ^e[1-9][0-9]*$`);
    return { kind: 'ref', ref };
  }
  const selector = t2StringField(options.selector, { name: `${name}selector`, maxBytes: T2_LIMITS.selectorBytes });
  return { kind: 'selector', selector };
}

/** Evidence projection of a target: a selector literal is never exposed (contract §5.2). */
function t2Requested(target) {
  if (!target) return { kind: 'document' };
  if (target.kind === 'ref') return { kind: 'ref', ref: target.ref };
  return { kind: 'selector' };
}

function t2AxValue(property) {
  if (!property || property.value === undefined) return null;
  const raw = property.value;
  if (raw && typeof raw === 'object' && 'value' in raw) return raw.value;
  return raw;
}

function t2AxProps(node) {
  const map = new Map();
  for (const property of Array.isArray(node.properties) ? node.properties : []) {
    if (property && typeof property.name === 'string') map.set(property.name, t2AxValue(property));
  }
  return map;
}

/** `Properties`-driven states in the contract's fixed token order. */
function t2StateTokens(props) {
  const tokens = [];
  const level = props.get('level');
  if (Number.isFinite(level)) tokens.push('level=' + level);
  if (props.get('disabled') === true) tokens.push('disabled');
  if (props.get('readonly') === true) tokens.push('readonly');
  const checked = props.get('checked');
  if (checked === true || checked === false) tokens.push('checked=' + String(checked));
  else if (checked === 'mixed') tokens.push('checked=mixed');
  if (props.get('selected') === true) tokens.push('selected');
  const expanded = props.get('expanded');
  if (expanded === true) tokens.push('expanded');
  else if (expanded === false) tokens.push('collapsed');
  if (props.get('required') === true) tokens.push('required');
  const invalid = props.get('invalid');
  if (invalid === true) tokens.push('invalid');
  else if (typeof invalid === 'string' && invalid && invalid !== 'false') tokens.push('invalid=' + invalid);
  if (props.get('focused') === true) tokens.push('focused');
  return tokens;
}

/**
 * One AX node -> one tree line plus the facts the ref table needs.
 *
 * `- role "name" [state…]` / `- text "content"`; input values are never appended (contract §3.1).
 * `refCandidate` is decided here so the DFS only has to number nodes in tree order.
 */
function t2FormatAxNode(node, { frameId = null, textOverride = undefined } = {}) {
  const role = t2TruncateBytes(node.role && typeof node.role.value === 'string' && node.role.value ? node.role.value : 'generic', T2_LIMITS.roleBytes);
  const props = t2AxProps(node);
  const rawName = node.name && node.name.value !== undefined && node.name.value !== null ? node.name.value : '';
  if (role === 'StaticText' || role === 'InlineTextBox') {
    const rawText = textOverride === undefined
      ? (node.value && node.value.value !== undefined && node.value.value !== null ? node.value.value : rawName)
      : textOverride;
    const text = t2FormatTextLeaf(rawText);
    return { line: '- text ' + JSON.stringify(text), role, name: text, refCandidate: false, isText: true, text };
  }
  const name = t2TruncateBytes(t2Public(rawName, T2_LIMITS.nameBytes), T2_LIMITS.nameBytes);
  const editable = props.get('editable');
  // `generic` never becomes a ref target: it is a non-semantic wrapper, and an editable generic is a
  // contenteditable editor this tier explicitly does not drive (contract §4.1 type clause). Keeping
  // it out of the ref table also keeps an anonymous wrapper from duplicating a same-role child line.
  const refCandidate = T2_REF_ROLES.has(role)
    || (role !== 'generic' && (editable === true || editable === 'richtext' || editable === 'plaintext'));
  const tokens = t2StateTokens(props);
  let line = '- ' + role + ' ' + JSON.stringify(name);
  if (tokens.length) line += ' [' + tokens.join('] [') + ']';
  return { line, role, name, refCandidate, isText: false, text: name, frameId };
}

function t2RoleIsContainer(role) {
  return T2_CONTAINER_ROLES.has(role);
}

/** Raw (pre-truncation, pre-redaction) AX accessors — redundancy checks must use these. */
function t2AxRoleOf(node) {
  return node && node.role && typeof node.role.value === 'string' && node.role.value ? node.role.value : 'generic';
}

function t2AxRawName(node) {
  return node && node.name && node.name.value !== undefined && node.name.value !== null ? String(node.name.value) : '';
}

function t2AxRawText(node) {
  const value = node && node.value && node.value.value !== undefined && node.value.value !== null ? String(node.value.value) : '';
  return value || t2AxRawName(node);
}

/**
 * True only when the accessible name provably comes from the node's own *contents*.
 *
 * `aria-label`, `aria-labelledby`, `title`, `placeholder` and other external sources disqualify the
 * node: suppressing a same-named child text under such an owner would delete the only visible text
 * (contract §3.1.1). `sources` carries empty candidate entries, so only non-empty values count.
 */
function t2NameFromContents(node) {
  const sources = node && node.name && Array.isArray(node.name.sources) ? node.name.sources : null;
  if (!sources || sources.length === 0) return false;
  let contents = false;
  for (const source of sources) {
    if (!source) continue;
    let value = source.value;
    if (value && typeof value === 'object') value = value.value;
    const text = value === undefined || value === null ? '' : String(value);
    if (!text) continue;
    if (source.type === 'contents') { contents = true; continue; }
    return false;
  }
  return contents;
}

const T2_AX_TEXT_ROLES = new Set(['StaticText', 'InlineTextBox', 'LabelText', 'text']);
/**
 * Roles whose children are structural and must never be swallowed by the redundancy rule, even when
 * the concatenated child text happens to equal the owner's name (contract §3.1.1).
 */
const T2_KEEP_CHILDREN_ROLES = new Set([
  'listitem', 'list', 'table', 'row', 'cell', 'celltable', 'gridcell', 'columnheader', 'rowheader',
  'image', 'img', 'canvas', 'iframe', 'Iframe', 'RootWebArea', 'WebArea', 'document', 'dialog',
  'option', 'tab', 'tablist', 'treeitem', 'menu', 'menubar', 'menuitem', 'menuitemcheckbox',
  'menuitemradio', 'combobox', 'listbox', 'textbox', 'searchbox', 'spinbutton', 'slider', 'switch',
  'checkbox', 'radio', 'group', 'radiogroup', 'application', 'article', 'region', 'form',
]);

/**
 * Ordered pure-text chain of a child list, or null when any child is a real semantic node.
 *
 * Only text representations (and ignored wrappers around them) may appear: a node with a ref, a
 * state, a name of its own, or any other role is a semantic boundary and returns null.
 */
function t2TextChain(children, childrenOf) {
  let raw = '';
  let leaves = 0;
  for (const child of children) {
    if (!child) return null;
    if (child.ignored === true) {
      const nested = t2TextChain(childrenOf.get(child.nodeId) || [], childrenOf);
      if (!nested) return null;
      raw += nested.raw;
      leaves += nested.leaves;
      continue;
    }
    const role = t2AxRoleOf(child);
    if (!T2_AX_TEXT_ROLES.has(role)) return null;
    raw += t2AxRawText(child);
    leaves += 1;
  }
  return leaves === 0 ? null : { raw, leaves };
}

/**
 * Is this node's whole child list a redundant second copy of the text the node already shows?
 *
 * Merging is deliberately local and provable: the children must be a pure text chain whose flattened
 * text equals the node's own flattened text, the node must carry that text on its own line (a named
 * owner, or a text leaf), a contents-derived name is required for named owners, structural roles are
 * excluded, and the surviving projection must render the identical visible string (so truncation or
 * redaction differences keep the more complete child representation instead of losing text).
 */
function t2IsRedundantTextSubtree(node, children, childrenOf) {
  if (!children.length) return false;
  const role = t2AxRoleOf(node);
  const chain = t2TextChain(children, childrenOf);
  if (!chain) return false;
  if (T2_AX_TEXT_ROLES.has(role)) {
    const own = t2Flatten(t2AxRawText(node));
    return own !== '' && t2Flatten(chain.raw) === own;
  }
  if (T2_KEEP_CHILDREN_ROLES.has(role)) return false;
  const name = t2Flatten(t2AxRawName(node));
  if (!name) return false;                       // an anonymous node's line carries no text
  if (!t2NameFromContents(node)) return false;    // aria-label/labelledby/unknown provenance: keep both
  if (t2Flatten(chain.raw) !== name) return false;
  const survivor = t2TruncateBytes(t2Public(name, T2_LIMITS.nameBytes), T2_LIMITS.nameBytes);
  const dropped = t2TruncateBytes(t2Public(chain.raw, T2_LIMITS.textBytes), T2_LIMITS.textBytes);
  return survivor === dropped;
}

/* --- page-side inspection (runs inside the page with the element as `this`) ------------------ */

/**
 * The one shared node inspector.
 *
 * Everything an action needs is read *inside* the page: computed style, layout rect, hit-test that
 * walks open shadow roots, disabled/inert ancestry, value/checked/expanded state, scroll box. The
 * raw `value` is returned for in-memory comparison only and is never published (contract §5.1).
 */
const T2_NODE_INFO_FN = `function (options) {
  var el = this;
  var doc = (el && el.ownerDocument) || document;
  var win = doc.defaultView || window;
  if (!el || el.nodeType !== 1) return { ok: false, reason: 'not-an-element', connected: false };
  // Optional preparation scroll (contract §4.1): the before-observation is already taken, and the
  // caller re-reads the rect afterwards so no cached geometry is ever used for the dispatch point.
  if (options && options.scrollIntoView) {
    try { el.scrollIntoView({ block: 'center', inline: 'center', behavior: 'instant' }); }
    catch (error) { try { el.scrollIntoView(); } catch (ignored) { /* detached element */ } }
  }
  var flatten = function (value) {
    return String(value === undefined || value === null ? '' : value)
      .replace(/[\\u200b-\\u200f\\u2060\\ufeff]/g, '')
      .replace(/\\s+/g, ' ')
      .trim();
  };
  var connected = el.isConnected === true;
  var sameDocument = false;
  try { sameDocument = el.ownerDocument === doc; } catch (error) { sameDocument = false; }
  var tagName = String(el.tagName || '').toLowerCase();
  var inputType = tagName === 'input' ? String(el.type || 'text').toLowerCase() : '';
  var ariaBool = function (value) { return value === 'true' ? true : value === 'false' ? false : value === 'mixed' ? 'mixed' : null; };
  var roleOf = function () {
    var explicit = el.getAttribute('role');
    if (explicit) { var first = flatten(explicit).split(' ')[0]; if (first) return first; }
    if (tagName === 'button') return 'button';
    if (tagName === 'a' || tagName === 'area') return el.hasAttribute('href') ? 'link' : 'generic';
    if (tagName === 'select') return el.multiple || Number(el.size) > 1 ? 'listbox' : 'combobox';
    if (tagName === 'textarea') return 'textbox';
    if (tagName === 'input') {
      if (inputType === 'checkbox') return 'checkbox';
      if (inputType === 'radio') return 'radio';
      if (inputType === 'range') return 'slider';
      if (inputType === 'number') return 'spinbutton';
      if (inputType === 'search') return 'searchbox';
      if (inputType === 'button' || inputType === 'submit' || inputType === 'reset' || inputType === 'image' || inputType === 'file') return 'button';
      if (inputType === 'hidden') return 'generic';
      return 'textbox';
    }
    if (/^h[1-6]$/.test(tagName)) return 'heading';
    if (tagName === 'img') return 'img';
    if (tagName === 'li') return 'listitem';
    if (tagName === 'ul' || tagName === 'ol') return 'list';
    if (tagName === 'table') return 'table';
    if (tagName === 'tr') return 'row';
    if (tagName === 'td') return 'cell';
    if (tagName === 'th') return 'columnheader';
    if (tagName === 'label') return 'label';
    if (tagName === 'dialog') return 'dialog';
    if (el.isContentEditable) return 'textbox';
    return 'generic';
  };
  var nameOf = function () {
    var label = el.getAttribute('aria-label');
    if (label && flatten(label)) return flatten(label);
    var labelledBy = el.getAttribute('aria-labelledby');
    if (labelledBy) {
      var joined = flatten(labelledBy.split(/\\s+/).map(function (id) { var node = doc.getElementById(id); return node ? node.textContent : ''; }).join(' '));
      if (joined) return joined;
    }
    if (tagName === 'input' || tagName === 'textarea' || tagName === 'select' || tagName === 'button') {
      if (el.labels && el.labels.length) {
        var fromLabels = flatten(Array.prototype.map.call(el.labels, function (labelNode) { return labelNode.textContent; }).join(' '));
        if (fromLabels) return fromLabels;
      }
      var placeholder = el.getAttribute('placeholder');
      if (placeholder && flatten(placeholder)) return flatten(placeholder);
      if (tagName === 'button' || (tagName === 'input' && (inputType === 'button' || inputType === 'submit' || inputType === 'reset'))) {
        var valueText = flatten(el.value);
        if (valueText) return valueText;
      }
    }
    if (tagName === 'img') { var alt = el.getAttribute('alt'); if (alt && flatten(alt)) return flatten(alt); }
    var title = el.getAttribute('title');
    if (title && flatten(title)) return flatten(title);
    return flatten(el.textContent);
  };
  var style = win.getComputedStyle(el);
  var rect = el.getBoundingClientRect();
  var hasRect = el.getClientRects().length > 0 && (rect.width > 0 || rect.height > 0);
  var checkVisible = true;
  try {
    if (typeof el.checkVisibility === 'function') {
      checkVisible = el.checkVisibility({ checkOpacity: true, checkVisibilityCSS: true, contentVisibilityAuto: true }) !== false;
    }
  } catch (error) { checkVisible = true; }
  var styleVisible = style.display !== 'none' && style.visibility !== 'hidden' && style.visibility !== 'collapse' && Number(style.opacity) > 0;
  var cssVisible = styleVisible && checkVisible;
  var hasBox = el.getClientRects().length > 0;
  var inertAncestor = false;
  var disabledFieldset = false;
  var cursor = el;
  var guardAncestor = 0;
  while (cursor && guardAncestor < 64) {
    if (cursor !== el && cursor.hasAttribute && cursor.hasAttribute('inert')) inertAncestor = true;
    if (cursor !== el && cursor.hasAttribute && cursor.hasAttribute('disabled') && String(cursor.tagName || '').toLowerCase() === 'fieldset') disabledFieldset = true;
    cursor = cursor.parentElement;
    guardAncestor += 1;
  }
  var innerWidth = win.innerWidth || 0;
  var innerHeight = win.innerHeight || 0;
  var inViewport = hasRect && rect.right > 0 && rect.bottom > 0 && rect.left < innerWidth && rect.top < innerHeight;
  var center = null;
  if (hasRect) {
    var left = Math.max(rect.left, 0);
    var top = Math.max(rect.top, 0);
    var right = Math.min(rect.right, innerWidth);
    var bottom = Math.min(rect.bottom, innerHeight);
    if (right > left && bottom > top) {
      center = { x: Math.round((left + right) / 2 * 100) / 100, y: Math.round((top + bottom) / 2 * 100) / 100 };
    }
  }
  var describe = function (node) {
    if (!node) return null;
    if (node.nodeType !== 1) return String(node.nodeName || '').toLowerCase();
    var nodeTag = String(node.tagName || '').toLowerCase();
    var id = node.getAttribute ? node.getAttribute('id') : null;
    var cls = node.getAttribute ? node.getAttribute('class') : null;
    var first = cls ? flatten(cls).split(' ')[0] : '';
    return nodeTag + (id ? '#' + id : '') + (first ? '.' + first : '');
  };
  var hitTarget = null;
  var coveredBy = null;
  if (center && el !== doc.body && el !== doc.documentElement) {
    var root = el.getRootNode ? el.getRootNode() : doc;
    var hit = null;
    try {
      hit = root && typeof root.elementFromPoint === 'function'
        ? root.elementFromPoint(center.x, center.y)
        : (typeof doc.elementFromPoint === 'function' ? doc.elementFromPoint(center.x, center.y) : null);
      var guard = 0;
      while (hit && hit.shadowRoot && guard < 8) {
        var inner = hit.shadowRoot.elementFromPoint(center.x, center.y);
        if (!inner || inner === hit) break;
        hit = inner;
        guard += 1;
      }
    } catch (error) { hit = null; }
    var selfHit = hit === el || (hit && typeof el.contains === 'function' && el.contains(hit));
    hitTarget = !!selfHit;
    if (!selfHit) coveredBy = describe(hit) || 'unknown-element';
  }
  var disabled = false;
  try { disabled = el.matches(':disabled') === true; } catch (error) { disabled = false; }
  if (!disabled) disabled = el.getAttribute('aria-disabled') === 'true';
  if (!disabled) disabled = disabledFieldset || inertAncestor;
  var readOnly = el.readOnly === true || el.getAttribute('aria-readonly') === 'true';
  var required = el.required === true || el.getAttribute('aria-required') === 'true';
  var checked = null;
  if (tagName === 'input' && (inputType === 'checkbox' || inputType === 'radio')) checked = el.checked === true;
  else if (el.getAttribute('aria-checked') !== null) checked = ariaBool(el.getAttribute('aria-checked'));
  else if (tagName === 'input') checked = null;
  var indeterminate = false;
  try { indeterminate = el.indeterminate === true; } catch (error) { indeterminate = false; }
  if (checked === false && indeterminate) checked = 'mixed';
  var selected = null;
  if (el.getAttribute('aria-selected') !== null) selected = ariaBool(el.getAttribute('aria-selected'));
  else if (tagName === 'option') selected = el.selected === true;
  var expanded = ariaBool(el.getAttribute('aria-expanded'));
  var invalid = null;
  if (el.getAttribute('aria-invalid') === 'true') invalid = true;
  else if (el.getAttribute('aria-invalid') && el.getAttribute('aria-invalid') !== 'false') invalid = String(el.getAttribute('aria-invalid'));
  else if (el.validity) invalid = el.validity.valid === false;
  // effective editability: a readonly/disabled/inert control is not editable even though its
  // tag is an input (contract 5.1 NodeState semantics).
  var editable = (tagName === 'input' || tagName === 'textarea')
    ? (readOnly !== true && disabled !== true && inertAncestor !== true && disabledFieldset !== true)
    : el.isContentEditable === true;
  var sensitive = false;
  var sensitiveName = String(el.getAttribute('id') || '') + ' ' + String(el.getAttribute('name') || '');
  var autocomplete = String(el.getAttribute('autocomplete') || '');
  if (inputType === 'password') sensitive = true;
  else if (/current-password|new-password|one-time-code/i.test(autocomplete)) sensitive = true;
  else if (/password|token|secret|auth|api-key|session/i.test(sensitiveName)) sensitive = true;
  var rawValue = null;
  if (tagName === 'select') {
    rawValue = el.multiple
      ? Array.prototype.map.call(el.selectedOptions, function (option) { return String(option.value); })
      : String(el.value === null || el.value === undefined ? '' : el.value);
  } else if (el.isContentEditable) rawValue = String(el.textContent === null || el.textContent === undefined ? '' : el.textContent);
  else if ((tagName === 'input' || tagName === 'textarea') && 'value' in el) rawValue = String(el.value === null || el.value === undefined ? '' : el.value);
  var activeElement = doc.activeElement;
  var guardFocus = 0;
  while (activeElement && activeElement.shadowRoot && activeElement.shadowRoot.activeElement && guardFocus < 8) {
    activeElement = activeElement.shadowRoot.activeElement;
    guardFocus += 1;
  }
  var focused = activeElement === el;
  var attributeLimit = Number(options && options.attributeLimit) || 20;
  var attributes = [];
  if (el.attributes) {
    for (var index = 0; index < el.attributes.length && attributes.length < attributeLimit; index += 1) {
      var attribute = el.attributes[index];
      if (!attribute || !attribute.name) continue;
      var attributeValue = /token|secret|password|auth|key|session|code/i.test(attribute.name)
        ? '***'
        : String(attribute.value === undefined || attribute.value === null ? '' : attribute.value).slice(0, 120);
      attributes.push({ name: String(attribute.name), value: attributeValue });
    }
  }
  var round = function (value2) { return Math.round(value2 * 100) / 100; };
  return {
    ok: true,
    connected: connected,
    ownerDocumentMatched: sameDocument,
    tagName: tagName,
    inputType: inputType || null,
    role: roleOf(),
    name: flatten(nameOf()).slice(0, 4000),
    sensitive: sensitive,
    cssVisible: cssVisible,
    hasBox: hasBox,
    visible: cssVisible && hasRect,
    enabled: !disabled,
    disabled: disabled,
    disabledFieldset: disabledFieldset,
    inert: inertAncestor,
    editable: editable,
    readOnly: readOnly,
    required: required,
    checked: checked,
    selected: selected,
    expanded: expanded,
    invalid: invalid,
    focused: focused,
    inViewport: inViewport,
    bbox: hasRect ? { x: round(rect.left), y: round(rect.top), width: round(rect.width), height: round(rect.height) } : null,
    center: center,
    hitTarget: hitTarget,
    coveredBy: coveredBy,
    computed: {
      display: String(style.display), visibility: String(style.visibility),
      opacity: String(style.opacity), pointerEvents: String(style.pointerEvents),
    },
    text: flatten(el.textContent === null || el.textContent === undefined ? '' : el.textContent).slice(0, 8000),
    value: rawValue === null ? null : (Array.isArray(rawValue) ? rawValue.slice(0, 20) : String(rawValue).slice(0, 8000)),
    attributes: attributes,
    scroll: {
      x: Math.round(el.scrollLeft || 0), y: Math.round(el.scrollTop || 0),
      scrollWidth: el.scrollWidth || 0, scrollHeight: el.scrollHeight || 0,
      clientWidth: el.clientWidth || 0, clientHeight: el.clientHeight || 0,
    },
    viewport: { width: innerWidth, height: innerHeight },
  };
}`;

/** The real (deep-shadow) activeElement, as a remote object so CDP can describe it. */
const T2_DEEP_FOCUS_FN = `(function () {
  var doc = document;
  var active = doc.activeElement;
  var guard = 0;
  while (active && active.shadowRoot && active.shadowRoot.activeElement && guard < 8) {
    active = active.shadowRoot.activeElement;
    guard += 1;
  }
  if (!active || active.nodeType !== 1 || active === doc.body || active === doc.documentElement) return null;
  return active;
})()`;

/** Two consecutive animation frames within 100ms: bbox must not move more than 1 CSS px. */
const T2_STABILITY_FN = `function () {
  var el = this;
  var doc = el.ownerDocument || document;
  var win = doc.defaultView || window;
  if (!el || el.nodeType !== 1) return Promise.resolve({ ok: false, reason: 'not-an-element' });
  var first = el.getBoundingClientRect();
  return new Promise(function (resolve) {
    var settled = false;
    var finish = function () {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      var second = el.getBoundingClientRect();
      var delta = Math.max(
        Math.abs(second.left - first.left), Math.abs(second.top - first.top),
        Math.abs(second.width - first.width), Math.abs(second.height - first.height)
      );
      resolve({
        ok: true,
        stable: delta <= 1,
        delta: Math.round(delta * 100) / 100,
        rect: { x: second.left, y: second.top, width: second.width, height: second.height },
      });
    };
    var timer = setTimeout(finish, 100);
    if (typeof win.requestAnimationFrame === 'function') {
      win.requestAnimationFrame(function () { win.requestAnimationFrame(finish); });
    } else {
      setTimeout(finish, 20);
    }
  });
}`;

/** Put the caret at the end of the current value (`replace:false` appends, never a random caret). */
const T2_CARET_END_FN = `function () {
  var el = this;
  var doc = (el && el.ownerDocument) || document;
  var win = doc.defaultView || window;
  if (!el || el.nodeType !== 1) return { ok: false, reason: 'not-an-element' };
  try { el.focus({ preventScroll: true }); } catch (error) { try { el.focus(); } catch (ignored) { /* no-op */ } }
  var length = String(el.value === null || el.value === undefined ? '' : el.value).length;
  if (typeof el.setSelectionRange === 'function') {
    try { el.setSelectionRange(length, length); return { ok: true, caret: length }; } catch (error) { return { ok: false, reason: 'selection-unsupported' }; }
  }
  return { ok: false, reason: 'selection-unsupported' };
}`;

/** Page-level observation: address/title/scroll/viewport plus whether a real element is focused. */
const T2_PAGE_STATE_FN = `(function () {
  var doc = document;
  var win = window;
  var active = doc.activeElement;
  var guard = 0;
  while (active && active.shadowRoot && active.shadowRoot.activeElement && guard < 8) {
    active = active.shadowRoot.activeElement;
    guard += 1;
  }
  var hasFocus = !!(active && active.nodeType === 1 && active !== doc.body && active !== doc.documentElement);
  var scroller = doc.scrollingElement || doc.documentElement;
  return {
    url: String(location.href),
    title: String(doc.title === undefined || doc.title === null ? '' : doc.title),
    scrollX: Math.round((win.scrollX || 0) * 100) / 100,
    scrollY: Math.round((win.scrollY || 0) * 100) / 100,
    viewportWidth: win.innerWidth || 0,
    viewportHeight: win.innerHeight || 0,
    hasFocus: hasFocus,
    documentScrollHeight: scroller ? scroller.scrollHeight : 0,
  };
})()`;

/** Read the target's (or the document's) scroll offsets for scroll evidence/stability. */
const T2_SCROLL_READ_FN = `function () {
  var el = this;
  var doc = (el && el.ownerDocument) || document;
  var win = doc.defaultView || window;
  var target = el;
  if (!el || el.nodeType !== 1) target = doc.scrollingElement || doc.documentElement;
  return {
    x: Math.round((target.scrollLeft || 0) * 100) / 100,
    y: Math.round((target.scrollTop || 0) * 100) / 100,
    windowX: Math.round((win.scrollX || 0) * 100) / 100,
    windowY: Math.round((win.scrollY || 0) * 100) / 100,
  };
}`;

/** Scroll container for a document-level scroll: `document.scrollingElement`. */
const T2_DOCUMENT_SCROLLER_FN = `(function () { return document.scrollingElement || document.documentElement; })()`;

/** Read an input's current value for in-memory verification only (never published). */
const T2_READ_VALUE_FN = `function () {
  var el = this;
  if (!el || el.nodeType !== 1) return { ok: false, reason: 'not-an-element' };
  var value = '';
  if (String(el.tagName || '').toLowerCase() === 'select') value = String(el.value === null || el.value === undefined ? '' : el.value);
  else if (el.isContentEditable) value = String(el.textContent === null || el.textContent === undefined ? '' : el.textContent);
  else value = String(el.value === null || el.value === undefined ? '' : el.value);
  return { ok: true, value: value, length: value.length };
}`;
/** Native `<select>` write (combobox): option *value* matching, never the native popup. */
const T2_SELECT_WRITE_FN = `function (payload) {
  var el = this;
  var doc = (el && el.ownerDocument) || document;
  var win = doc.defaultView || window;
  if (!el || el.nodeType !== 1) return { ok: false, reason: 'not-an-element' };
  if (String(el.tagName || '').toLowerCase() !== 'select') return { ok: false, reason: 'not-a-select' };
  var wanted = payload && Array.isArray(payload.values) ? payload.values.map(String) : [String(payload && payload.values)];
  var options = Array.prototype.slice.call(el.options || []);
  var available = options.map(function (option) { return String(option.value); });
  var disabledValues = options.filter(function (option) { return option.disabled === true; }).map(function (option) { return String(option.value); });
  var missing = wanted.filter(function (item) { return available.indexOf(item) < 0; });
  var unavailable = wanted.filter(function (item) { return disabledValues.indexOf(item) >= 0; });
  var before = el.multiple
    ? Array.prototype.map.call(el.selectedOptions, function (option) { return String(option.value); })
    : String(el.value === null || el.value === undefined ? '' : el.value);
  if (el.multiple) {
    for (var index = 0; index < options.length; index += 1) {
      options[index].selected = wanted.indexOf(String(options[index].value)) >= 0;
    }
  } else if (wanted.length) {
    var descriptor = Object.getOwnPropertyDescriptor(win.HTMLSelectElement.prototype, 'value');
    if (descriptor && typeof descriptor.set === 'function') descriptor.set.call(el, wanted[0]);
    else el.value = wanted[0];
  }
  el.dispatchEvent(new win.Event('input', { bubbles: true }));
  el.dispatchEvent(new win.Event('change', { bubbles: true }));
  var after = el.multiple
    ? Array.prototype.map.call(el.selectedOptions, function (option) { return String(option.value); })
    : String(el.value === null || el.value === undefined ? '' : el.value);
  return { ok: true, before: before, after: after, missing: missing, unavailable: unavailable };
}`;

/** Native value write for `input[type=range]` (slider) and for clearing a textbox. */
const T2_VALUE_WRITE_FN = `function (payload) {
  var el = this;
  var doc = (el && el.ownerDocument) || document;
  var win = doc.defaultView || window;
  if (!el || el.nodeType !== 1) return { ok: false, reason: 'not-an-element' };
  var tag = String(el.tagName || '').toLowerCase();
  if (tag !== 'input' && tag !== 'textarea') return { ok: false, reason: 'not-a-form-control' };
  var proto = tag === 'textarea' ? win.HTMLTextAreaElement.prototype : win.HTMLInputElement.prototype;
  var descriptor = Object.getOwnPropertyDescriptor(proto, 'value');
  var next = payload && payload.value !== undefined && payload.value !== null ? String(payload.value) : '';
  var before = String(el.value === null || el.value === undefined ? '' : el.value);
  if (descriptor && typeof descriptor.set === 'function') descriptor.set.call(el, next);
  else el.value = next;
  el.dispatchEvent(new win.Event('input', { bubbles: true }));
  el.dispatchEvent(new win.Event('change', { bubbles: true }));
  return { ok: true, before: before, after: String(el.value === null || el.value === undefined ? '' : el.value) };
}`;

/** Read-only option inventory for a native select (pre-check, never mutates). */
const T2_SELECT_OPTIONS_FN = `function () {
  var el = this;
  if (!el || el.nodeType !== 1) return { ok: false, reason: 'not-an-element' };
  if (String(el.tagName || '').toLowerCase() !== 'select') return { ok: false, reason: 'not-a-select' };
  var options = Array.prototype.map.call(el.options || [], function (option) {
    return { value: String(option.value), disabled: option.disabled === true };
  });
  return { ok: true, multiple: el.multiple === true, options: options };
}`;

/** Range bounds used to validate a slider value before any write (contract §2.2 Field table). */
const T2_RANGE_INFO_FN = `function () {
  var el = this;
  if (!el || el.nodeType !== 1) return { ok: false, reason: 'not-an-element' };
  var tag = String(el.tagName || '').toLowerCase();
  var type = tag === 'input' ? String(el.type || '').toLowerCase() : '';
  if (tag !== 'input' || type !== 'range') return { ok: false, reason: 'not-a-range' };
  var min = el.min === '' || el.min === undefined ? 0 : Number(el.min);
  var max = el.max === '' || el.max === undefined ? 100 : Number(el.max);
  var stepRaw = String(el.step === undefined || el.step === null ? '' : el.step);
  return {
    ok: true,
    min: Number.isFinite(min) ? min : 0,
    max: Number.isFinite(max) ? max : 100,
    step: stepRaw === '' ? 1 : (stepRaw === 'any' ? null : Number(stepRaw)),
    value: String(el.value === null || el.value === undefined ? '' : el.value),
  };
}`;

/** Precise scroll for `to:"top"|"bottom"`: explicit value, not a repeated wheel (contract §4.3). */
const T2_SCROLL_TO_FN = `function (payload) {
  var el = this;
  var doc = (el && el.ownerDocument) || document;
  var win = doc.defaultView || window;
  if (!el || el.nodeType !== 1) return { ok: false, reason: 'not-an-element' };
  var target = el;
  if (el === doc.body || el === doc.documentElement) target = doc.scrollingElement || doc.documentElement;
  var to = payload && payload.to === 'bottom' ? 'bottom' : 'top';
  var top = to === 'bottom' ? Math.max(0, (target.scrollHeight || 0) - (target.clientHeight || 0)) : 0;
  var before = { x: Math.round((target.scrollLeft || 0) * 100) / 100, y: Math.round((target.scrollTop || 0) * 100) / 100 };
  try {
    if (typeof target.scrollTo === 'function') target.scrollTo({ top: top, behavior: 'instant' });
    else target.scrollTop = top;
  } catch (error) { target.scrollTop = top; }
  return {
    ok: true,
    to: to,
    isDocument: target === doc.scrollingElement || target === doc.documentElement,
    before: before,
    after: { x: Math.round((target.scrollLeft || 0) * 100) / 100, y: Math.round((target.scrollTop || 0) * 100) / 100 },
    windowScrollY: Math.round((win.scrollY || 0) * 100) / 100,
  };
}`;

const LEGACY_SCOPE = Object.freeze({ key: 'legacy:default', scope: Object.freeze({ id: 'legacy:default', kind: 'legacy', workspaceId: null, degraded: false }) });
const UNASSIGNED_SCOPE = Object.freeze({ key: 'unassigned:owner', scope: Object.freeze({ id: 'unassigned:owner', kind: 'unassigned', workspaceId: null, degraded: false }) });

function workspaceScope(workspaceId) {
  return {
    key: `workspace:${workspaceId}`,
    scope: { id: `ws_${sha256Short(workspaceId)}`, kind: 'workspace', workspaceId, degraded: false },
  };
}

function pathScope(canonicalPath) {
  const hash = sha256Short(canonicalPath, 32);
  return { key: `path:${hash}`, scope: { id: `path:${hash}`, kind: 'path', workspaceId: null, degraded: true } };
}

function sessionScope(sessionId) {
  const hash = sha256Short(sessionId, 32);
  return { key: `session:${hash}`, scope: { id: `session:${hash}`, kind: 'session', workspaceId: null, degraded: true } };
}

/** One headless browser plus the page being previewed. */

/**
 * Session responses mirror the important session fields at the top level too (`counters`,
 * `state`, `sessionId`, `seq`): the acceptance probes read both `value.session.*` and
 * `value.counters.*`, and a missing alias made a *correct* implementation look broken.
 */
function sessionAliases(status) {
  const session = status && status.session ? status.session : null;
  return {
    state: session ? session.state : null,
    sessionId: session ? session.id : null,
    seq: session && session.counters ? session.counters.seq : 0,
    counters: session ? session.counters : null,
  };
}

export class Runtime {
  /**
   * @param log logger
   * @param {{host?: BrowserHost, origins?: Set<string>, scope?: object, registry?: RuntimeRegistry}} [options]
   *   With `host` the runtime uses the plugin-wide BrowserHost: close() only closes its own page
   *   target and clears its own state. Without it (legacy `new Runtime(log)`, used by
   *   runtime-faults) the runtime owns a private BrowserHost, so close() still tears down the
   *   Chromium process and the temporary profile exactly as before.
   */
  constructor(log, options = {}) {
    this.log = log;
    this.registry = options.registry;
    this.scope = options.scope || LEGACY_SCOPE.scope;
    this.ownsHost = !options.host;
    this.host = options.host || new BrowserHost(log);
    this.origins = options.origins || new Set();
    this.cdp = undefined;
    /** { targetId, generation } of this runtime's own page target (undefined when cold). */
    this.page = undefined;
    this.frames = new FrameSource();
    this.frameTransport = undefined;
    this.clientMetrics = undefined;
    this.ackFailures = 0;
    this.cdpOff = undefined;
    this.closing = undefined;
    this.network = [];
    this.requests = new Map();
    this.url = '';
    this.title = '';
    // Shared viewport authority (docs/viewport-control.md §3.1). `viewport` below is a read-only
    // alias so the historical `{width,height}` field can never drift from `view`.
    this.view = {
      version: 1,
      x: VIEW_LIMITS.default.x,
      y: VIEW_LIMITS.default.y,
      width: VIEW_LIMITS.default.width,
      height: VIEW_LIMITS.default.height,
      scale: VIEW_LIMITS.default.scale,
      source: 'default',
      revision: 0,
    };
    /** Last real `Page.getLayoutMetrics` readback (null until the page was actually observed). */
    this.observed = null;
    // Merged background observation of the layout viewport (docs/viewport-control.md §3.2): set by
    // request/action triggers only — there is deliberately no standing 5Hz timer.
    this.viewObserveTimer = 0;
    this.viewObserveDue = [];
    this.viewObserving = false;
    this.viewObserveAt = 0;
    /** Last GUI originId that wrote the view (Agent writes keep it null); diagnostics only. */
    this.viewOriginId = null;
    this.activity = '空闲';
    this.agentUntil = 0;
    this.humanUntil = 0;
    this.lastError = '';
    this.lastErrorAt = 0;
    this.lastErrorActionId = null;
    this.lastErrorTarget = null;
    this.starting = undefined;
    this.queue = Promise.resolve();
    this.lease = undefined;
    this.active = 0;
    // Every queued/running operation (agent OR panel): idle sweep/LRU must never close a page
    // that has work in flight.
    this.inflight = 0;
    this.navigationError = undefined;
    // GUI address/history projection (HTTP-only, never part of the browser_state tool value).
    this.runtimeId = randomUUID();
    this.uiRevision = 0;
    this.mainFrameId = undefined;
    this.history = emptyHistory();
    this.metadataGeneration = 0;
    this.metadataInFlight = false;
    this.metadataStartedAt = 0;
    this.metadataDirty = false;
    this.metadataRetryTimer = 0;
    // Viewer accounting: a WS connection alone can leak (no Close frame), so a viewer is only
    // visible while the panel keeps posting /metrics within VIEWER_TTL_MS.
    this.viewerUntil = 0;
    this.viewerSockets = 0;
    this.screencastFrames = 0;
    this.screencastAcks = 0;
    this.navigationCount = 0;
    // P0 capture evidence: the last successful browser_screenshot facts (browser_capabilities
    // reports them as `capture.observed`; capabilities never starts a browser to get them).
    this.captureObservation = null;
    // Cached Browser.getVersion projection ({ product, headless }); set on first capture.
    this.productInfo = undefined;
    // Web T3 (docs/t3-vision.md §1.1): one product store per workspace scope, owned by the plugin
    // instance and independent of the page lifecycle — a page navigation/close keeps the stored
    // images analysable offline (their actionable资格 is invalidated separately). Only dispose
    // (plugin unload / runtime retire) clears it.
    this.visionProducts = new vision.VisionProductStore({ now: () => Date.now() });
    // Provenance per product (runtimeId/pageGeneration/documentEpoch) so `act` can prove it is
    // operating on the same page generation, and evidence can cite the capture lineage.
    this.visionProvenance = new Map();
    // Last real vision call of this Runtime, projected into browser_capabilities.vision.observed
    // (numbers/status only — never an image, an absolute path or page text).
    this.visionObservation = null;
    // Web T2 runtime state (docs/t2-structured-gui.md §3.2, §5).
    //
    // `snapshot` is the single published ref table of this Runtime: `browser_snapshot` replaces it
    // atomically, and it is dropped on a main-frame document commit, on main-context loss and on
    // close. `documentEpoch` is bumped at those same points, so a ref can never be resolved against
    // a document that has since been replaced. `networkEntries`/`networkSeq` give evidence a
    // monotonic window instead of a Date.now() boundary guess.
    //
    // `refs` is the Runtime-scoped registry (contract §3.2): ref numbers grow monotonically and are
    // never reused, entries are keyed for reuse by `documentEpoch:backendNodeId`, and each entry
    // remembers the capture that minted it. `capture` is the most recent successful snapshot (its
    // snapshotId/digest are what selector/document operations cite in evidence). `documentEpoch` is
    // bumped whenever the document is replaced, which also clears the registry.
    this.t2 = {
      refs: new Map(),
      refByKey: new Map(),
      capture: null,
      captureSeq: 0,
      nextRefSeq: 0,
      refUseSeq: 1,
      documentEpoch: 0,
      networkSeq: 0,
      networkEntries: [],
      networkEvicted: [],
    };
    // Web P0 network collection (docs/network-p0.md §3/§4). One NetworkStore per Runtime (= per
    // workspace scope): the ring buffer, bodies, steps, links, artifacts and subscriptions are all
    // scope-local. `netControl` is the interception/throttle/hold state machine; `netTargets` maps
    // an auto-attached child CDP session to its target so every event can be attributed.
    this.net = new network.NetworkStore({ scopeId: this.scope.id });
    this.netCtl = new network.ControlState();
    this.netTargets = new Map();
    this.netReq = new Map();
    this.netHops = new Map();
    this.netPending = new Map();
    this.netCacheHits = new Set();
    this.netFetchKey = '';
    this.netFetchPatterns = null;
    this.netHoldTimer = null;
    this.netBodyTimeoutMs = 1500;
    // Tool-surface evidence: last real network tool call (projected into capabilities.network).
    this.net.observed = null;
    this.lastNetSessionId = null;
    this.viewerTtlMs = Number.isFinite(options.viewerTtlMs) ? options.viewerTtlMs : VIEWER_TTL_MS;
  }

  // Read-only forwarding for shared hosts: the process/profile belong to the BrowserHost, not to
  // this Runtime. Legacy private runtimes keep the historical `runtime.proc` / `runtime.profileDir`.
  get proc() { return this.host ? this.host.proc : undefined; }
  get profileDir() { return this.host ? this.host.profileDir : undefined; }
  get port() { return this.host ? this.host.port : 0; }
  get cleanupError() { return this.host ? this.host.cleanupError : null; }
  get running() { return Boolean(this.cdp && !this.cdp.closed); }
  get viewers() { return this.viewerUntil > Date.now() ? this.viewerSockets : 0; }
  /**
   * Historical top-level alias `viewport={width,height}` (docs/viewport-control.md §3.1 keeps it):
   * it is a getter over `view` so the two can never disagree. Callers that need x/y/scale read
   * `viewProjection()` instead.
   */
  get viewport() { return { width: this.view.width, height: this.view.height }; }

  /** A visible viewer heartbeat (metrics POST / WS connect). state/frame polls never call this. */
  touchViewer() { this.viewerUntil = Date.now() + this.viewerTtlMs; }
  addViewer() { this.viewerSockets += 1; this.touchViewer(); }
  removeViewer() { this.viewerSockets = Math.max(0, this.viewerSockets - 1); }

  /**
   * Bring this runtime's page to the front.
   *
   * Chromium only composites (and therefore only emits `Page.screencastFrame` for) the front
   * page target; a background page's preview would silently freeze. The panel's viewer heartbeat
   * and every page operation call this (throttled), so the workspace being previewed/operated is
   * the one producing frames. Known limitation: with several panels open at once the previews
   * alternate instead of updating simultaneously, and the page's `visibilityState` follows.
   */
  activate() {
    const now = Date.now();
    if (this.activateAt && now - this.activateAt < 300) return;
    this.activateAt = now;
    const cdp = this.cdp;
    if (!cdp || cdp.closed) return;
    cdp.send('Page.bringToFront', {}, { timeoutMs: 1000 }).catch(() => {});
  }

  hasLease() { return Boolean(this.lease && (this.active || this.lease.expiresAt > Date.now())); }

  /** Idle sweep / LRU eviction is only allowed when nothing is using this page. */
  evictable() { return this.active === 0 && this.inflight === 0 && !this.hasLease() && this.viewers === 0; }

  claim(sessionId) {
    if (this.active && this.activeOwner !== sessionId) throw new BrowserError('BUSY', '浏览器有其他会话操作排队或执行中');
    if (this.lease && this.lease.sessionId !== sessionId && (this.active || this.lease.expiresAt > Date.now())) {
      throw new BrowserError('BUSY', '浏览器由其他会话持有', { owner: this.lease.sessionId });
    }
    this.lease = { sessionId, expiresAt: Date.now() + AGENT_HOLD_MS };
  }

  release(sessionId) {
    if (this.lease?.sessionId === sessionId) this.lease = undefined;
  }

  /**
   * Serialise one page/network operation behind the single-owner lease.
   *
   * `action` ({actionId,target}) marks a real page/network operation: only those record failures
   * and clear the error projection (contract §9.1). Diagnostics, HTTP requests, BUSY and
   * pre-validation failures pass no action, so they can never overwrite another owner's error.
   */
  async run(operation, { signal, sessionId = 'anonymous', agent = false, action } = {}) {
    checkAbort(signal);
    this.inflight += 1;
    if (agent) { this.claim(sessionId); this.activeOwner = sessionId; this.active += 1; }
    // The page being operated must be the compositing one, otherwise its preview freezes.
    this.activate();
    const previous = this.queue;
    let unlock;
    const turn = new Promise((resolve) => { unlock = resolve; });
    this.queue = previous.then(() => turn);
    let entered = false;
    try {
      await abortable(previous, signal);
      checkAbort(signal);
      if (agent) this.claim(sessionId);
      entered = true;
      const result = await operation();
      checkAbort(signal);
      if (agent) this.claim(sessionId);
      if (action) this.clearError();
      return result;
    } catch (error) {
      const classified = asBrowserError(error);
      // VIEWPORT_CONFLICT is an optimistic-concurrency answer, not a page failure: like an
      // invalid argument it must not overwrite the owner's lastError (docs/viewport-control.md §7.1).
      if (entered && action && !['INVALID_ARGUMENT', 'UNSUPPORTED', 'BUSY', 'VIEWPORT_CONFLICT'].includes(classified.code)) {
        this.setError(classified.message, action);
      }
      // A rejected CDP wait cannot retract an already dispatched command. Close before allowing
      // the next writer, rather than letting that command mutate a later operation's page.
      if (entered && ['ABORTED', 'CDP_TIMEOUT', 'CDP_DISCONNECTED'].includes(classified.code)) await this.close();
      throw classified;
    } finally {
      this.inflight = Math.max(0, this.inflight - 1);
      if (agent) {
        this.active -= 1;
        if (this.lease?.sessionId === sessionId) this.lease.expiresAt = Date.now() + AGENT_HOLD_MS;
      }
      previous.finally(unlock);
    }
  }

  async refreshTitle(signal) {
    if (!this.cdp || this.cdp.closed) return;
    const result = await this.cdp.send('Runtime.evaluate', {
      expression: '({title:document.title,url:location.href})', returnByValue: true,
    }, { signal });
    if (result.result?.value) {
      this.title = result.result.value.title;
      this.url = result.result.value.url;
    }
  }

  /**
   * Read the browser's own navigation history. Only the aggregate projection is kept: the GUI
   * needs "can I go back/forward", not the entry list (entry URLs are not exposed at all).
   */
  async refreshHistory(signal) {
    const info = await this.send('Page.getNavigationHistory', {}, signal);
    return this.#applyHistory(info);
  }

  #applyHistory(info) {
    const entries = Array.isArray(info?.entries) ? info.entries : [];
    const index = Number(info?.currentIndex);
    this.history = !entries.length || !Number.isInteger(index) || index < 0 || index >= entries.length
      ? emptyHistory()
      : { available: true, index, length: entries.length, canGoBack: index > 0, canGoForward: index < entries.length - 1 };
    return this.history;
  }

  /**
   * Read the CDP history for a *write* path.
   *
   * During a cross-document commit the page session can briefly answer `Page.getNavigationHistory`
   * with "Not attached to an active page" (the new renderer is not attached yet). That is a
   * transient race, not "this browser has no history", so retry briefly inside the write path
   * before falling back to the disabled projection. Retries only happen on failure, so the
   * normal path costs no extra round trip.
   */
  async #refreshHistoryForWrite(signal) {
    const delays = [0, 0, 5, 10, 20];
    for (const delay of delays) {
      if (delay) await new Promise((resolve) => setTimeout(resolve, delay));
      checkAbort(signal);
      try { return await this.refreshHistory(signal); }
      catch (error) {
        if (error && error.code === 'ABORTED') throw error;
        if (error && ['CDP_DISCONNECTED', 'CDP_TIMEOUT'].includes(error.code)) throw error;
      }
    }
    // A persistent failure is not "a single-entry history": disable both directions.
    this.history = emptyHistory();
    return this.history;
  }

  /** Authoritative URL/title/history read on the write path (after a navigation commit). */
  async refreshMetadata(signal) {
    await this.refreshTitle(signal);
    await this.#refreshHistoryForWrite(signal);
    return { url: redactUrl(this.url), title: this.title, history: { ...this.history } };
  }

  /**
   * Opportunistic metadata refresh for the polling UI: never blocks the state response, never
   * enters the write queue and never takes the lease. 250ms throttle + single-flight, so the
   * 80ms /frame poll cannot turn into one CDP read per poll. A read is published only while it
   * still belongs to the same CDP connection and metadata generation; a stale result is dropped
   * and the state is marked dirty for one coalesced retry instead of overwriting newer data.
   */
  refreshMetadataSoon() {
    const cdp = this.cdp;
    if (!cdp || cdp.closed || this.metadataInFlight) return;
    const now = Date.now();
    if (now - this.metadataStartedAt < METADATA_THROTTLE_MS) return;
    this.metadataStartedAt = now;
    this.metadataInFlight = true;
    const generation = this.metadataGeneration;
    this.#readMetadata(cdp, generation).catch(() => {}).finally(() => {
      this.metadataInFlight = false;
      if (!this.metadataDirty) return;
      this.metadataDirty = false;
      this.#scheduleMetadataRetry();
    });
  }

  #scheduleMetadataRetry() {
    if (this.metadataRetryTimer || !this.cdp || this.cdp.closed) return;
    const wait = Math.max(0, METADATA_THROTTLE_MS - (Date.now() - this.metadataStartedAt));
    this.metadataRetryTimer = setTimeout(() => { this.metadataRetryTimer = 0; this.refreshMetadataSoon(); }, wait);
    this.metadataRetryTimer.unref?.();
  }

  async #readMetadata(cdp, generation) {
    const stale = () => this.cdp !== cdp || cdp.closed || this.metadataGeneration !== generation;
    const result = await cdp.send('Runtime.evaluate', {
      expression: '({title:document.title,url:location.href})', returnByValue: true,
    }, { timeoutMs: 5000 });
    if (stale()) { this.metadataDirty = true; return; }
    if (result.result?.value) {
      this.title = result.result.value.title;
      this.url = result.result.value.url;
    }
    const info = await cdp.send('Page.getNavigationHistory', {}, { timeoutMs: 5000 });
    if (stale()) { this.metadataDirty = true; return; }
    this.#applyHistory(info);
  }

  async send(method, params = {}, signal) {
    checkAbort(signal);
    return this.cdp.send(method, params, { signal });
  }

  mode() {
    const now = Date.now();
    if (now < this.agentUntil) return 'agent';
    if (now < this.humanUntil) return 'human';
    return 'idle';
  }

  async ensure(signal) {
    checkAbort(signal);
    // A close (eviction / panel /close / abort cleanup) may be in flight for this runtime: the
    // new page must not be created while the old target is still being torn down, otherwise the
    // close's late closePage() would kill the freshly created target.
    if (this.closing) {
      try { await this.closing; } catch { /* ignore */ }
      checkAbort(signal);
    }
    if (this.cdp && !this.cdp.closed) return this.cdp;
    if (this.starting) return abortable(this.starting, signal);
    if (this.page || this.cdp || (this.ownsHost && (this.host.proc || this.host.profileDir))) await this.close();
    this.starting = (async () => {
      // The page-slot reservation is taken before any await that could create a page, so N
      // concurrent first ensures can never exceed the cap (and the 9th gets RUNTIME_LIMIT).
      const release = this.registry ? await this.registry.reservePageSlot(this) : () => {};
      try {
        return await this.#start(signal);
      } finally {
        release();
      }
    })().finally(() => { this.starting = undefined; });
    return abortable(this.starting, signal);
  }

  async #start(signal) {
    const host = this.host;
    const page = await host.createPage(this, signal);
    const cdp = page.cdp;
    this.page = { targetId: page.targetId, generation: page.generation };
    this.cdp = cdp;
    // A new page/CDP generation invalidates any metadata read still in flight from the old one.
    this.metadataGeneration += 1;
    // Bind every page event to this exact cdp: a stale page's events must never mutate a
    // re-opened page (or another workspace's page) after close/abort/reconnect.
    this.cdpOff = cdp.on((message) => {
      if (this.cdp !== cdp) return;
      this.#onEvent(message);
    });
    try {
      await this.send('Page.enable', {}, signal);
      await this.send('Runtime.enable', {}, signal);
      await this.send('Network.enable', { maxTotalBufferSize: 5000000 }, signal);
      // One merged Fetch configuration: the Document navigation guard plus any active interception
      // rule. A second Fetch.enable would silently replace this one and kill the guard
      // (docs/network-p0.md §7.3 / R1-8).
      this.netFetchKey = '';
      await this.#netSyncFetch(signal);
      if (this.net.running && this.netCtl.needsArm) {
        this.netCtl.needsArm = false;
        const armed = this.net.config.captureWorkers ? await this.#netArmAutoAttach(signal) : { ok: false, reason: 'capture-disabled:workers' };
        if (!armed.ok && this.net.config.captureWorkers && !this.net.issues.includes('workers-not-attributable')) {
          this.net.issues.push('workers-not-attributable');
        }
      }
      await this.send('DOM.enable', {}, signal);
      await this.send('CSS.enable', {}, signal);
      // Same-document navigations are only meaningful for the main frame; remember which one it is.
      const tree = await this.send('Page.getFrameTree', {}, signal);
      this.mainFrameId = tree && tree.frameTree && tree.frameTree.frame ? tree.frameTree.frame.id : undefined;
      await this.applyViewport(this.view.width, this.view.height, signal);
      // First real observation of this page: `observed` goes from null (cold) to the measured
      // layout viewport. Best effort — a Chromium without css* metrics keeps observed=null.
      await this.refreshViewObservation(signal);
      await cdp.send('Page.startScreencast', {
        format: 'jpeg',
        quality: 72,
        maxWidth: 1600,
        maxHeight: 1200,
        everyNthFrame: 1,
      }, { signal });
      // A successful (re)initialisation is a clean runtime state: no stale page error.
      this.clearError();
      // Publish the fresh runtime state (history/url/title) once the page is up.
      this.refreshMetadataSoon();
      this.activate();
      this.log(`page target ${page.targetId} ready (generation ${page.generation})`);
      return cdp;
    } catch (error) {
      // A failed page start must not leave a target, a connection or a listener behind. The
      // shared browser/profile stay alive for the other workspaces.
      try { if (this.cdpOff) this.cdpOff(); } catch { /* ignore */ }
      this.cdpOff = undefined;
      try { cdp.close(); } catch { /* ignore */ }
      if (this.cdp === cdp) this.cdp = undefined;
      this.page = undefined;
      try { await host.closePage(this); } catch { /* ignore */ }
      try { await this.registry?.maybeCloseHost(); } catch { /* ignore */ }
      throw error;
    }
  }

  #onEvent(message) {
    // Child targets (worker / OOPIF) are auto-attached on the page connection (§3.1/R1-6).
    if (message.method === 'Target.attachedToTarget' || message.method === 'Target.detachedFromTarget') {
      this.#netOnTarget(message);
      return;
    }
    // Every Network.* event feeds the P0 collector first; the legacy buffers below keep their own
    // (unchanged) bookkeeping so browser_network / P6 / P21 / T2 networkDelta never move.
    if (typeof message.method === 'string' && message.method.startsWith('Network.')) {
      // A collector bug must never break the page's network pipeline: the dispatcher catches it and
      // records it as a session issue instead of letting the exception escape.
      try {
        this.#netOnEvent(message);
      } catch (error) {
        if (!this.net.issues.includes('collector-error')) this.net.issues.push('collector-error');
      }
    }
    if (message.method === 'Fetch.requestPaused') {
      // One dispatcher, one termination per request (guard → rules → continue).
      this.#onFetchPaused(message).catch((error) => {
        // Never leave a request paused: an exception in the rule handling must still release it,
        // otherwise the page waits forever (C36/C40).
        const target = this.cdp;
        if (target && !target.closed && message.params && message.params.requestId) {
          target.send('Fetch.continueRequest', { requestId: message.params.requestId }, { sessionId: message.sessionId || undefined, timeoutMs: 2000 }).catch(() => { });
        }
      });
      return;
    }
    if (['Page.loadEventFired', 'Page.domContentEventFired'].includes(message.method)) {
      this.refreshMetadataSoon();
      return;
    }
    if (message.method === 'Page.screencastFrame') {
      const params = message.params;
      this.screencastFrames += 1;
      const metadata = params.metadata || {};
      const scale = metadata.pageScaleFactor || 1;
      const width = Number(metadata.deviceWidth) || this.viewport.width;
      const height = Number(metadata.deviceHeight) || this.viewport.height;
      this.frames.accept({
        data: params.data,
        format: 'jpeg',
        width,
        height,
        pageWidth: Math.round(width / scale),
        pageHeight: Math.round(height / scale),
        capturedAt: metadata.timestamp,
      });
      // ACK immediately after the frame is cached: Chromium will not emit the next frame
      // until it is acknowledged. A lost ACK surfaces as stopped frames, so count failures.
      if (this.cdp) {
        this.cdp.send('Page.screencastFrameAck', { sessionId: params.sessionId }).then(() => { this.screencastAcks += 1; }).catch((error) => {
          this.ackFailures += 1;
          this.log('screencast ack failed: ' + String((error && error.message) || error));
        });
      }
      return;
    }
    if (message.method === 'Page.frameNavigated' && message.params.frame.parentId === undefined) {
      const frame = message.params.frame;
      this.navigationCount += 1;
      this.mainFrameId = frame.id;
      const fragment = typeof frame.urlFragment === 'string' && frame.urlFragment && !String(frame.url).includes('#')
        ? '#' + frame.urlFragment
        : '';
      this.url = String(frame.url || '') + fragment;
      this.title = '';
      this.metadataGeneration += 1;
      // A cross-document commit detaches every node the ref table points at: bump the document epoch
      // (dropping the snapshot) at the same moment the address bar changes, so no later action can
      // resolve a ref from the old document. Same-document navigations (pushState/hash) keep their
      // refs — the nodes are still there, and identity is re-verified per action.
      this.#t2BumpDocumentEpoch();
      this.frames.markNavigation(redactUrl(this.url));
      // Page-state ↔ network correlation (docs/network-p0.md §3.3 / G2.6): one state mark per
      // committed main-frame navigation, so the timeline can show which page the traffic belongs to.
      this.netMark({ kind: 'state', text: 'navigate', url: this.url });
      this.refreshMetadataSoon();
      // A commit resets the document scroll: refresh x/y once the new document is observable.
      this.refreshViewObservationSoon();
      return;
    }
    if (message.method === 'Page.navigatedWithinDocument') {
      // pushState / replaceState / hash change / popstate in the main frame only: a child iframe
      // must never rewrite the address bar, and a same-document navigation is not a new epoch.
      if (message.params.frameId === this.mainFrameId) {
        this.url = String(message.params.url || this.url);
        this.metadataGeneration += 1;
        this.netMark({ kind: 'state', text: 'history', url: this.url });
        this.refreshMetadataSoon();
      }
      return;
    }
    if (['Network.requestWillBeSent', 'Network.responseReceived', 'Network.loadingFailed', 'Network.loadingFinished'].includes(message.method)) {
      this.#t2NetworkSeq(message);
    }
    if (message.method === 'Runtime.executionContextsCleared') {
      // The main renderer context was destroyed (navigation/reload): every ref is detached.
      this.#t2BumpDocumentEpoch();
      return;
    }
    if (message.method === 'Network.requestWillBeSent') {
      const params = message.params;
      this.requests.set(params.requestId, {
        url: redactUrl(params.request.url),
        redacted: true,
        method: params.request.method || null,
        type: params.type || null,
        at: Number.isFinite(params.timestamp) ? params.timestamp : null,
        status: 0,
      });
      if (this.requests.size > NETWORK_LIMIT) this.requests.delete(this.requests.keys().next().value);
      return;
    }
    if (message.method === 'Network.loadingFailed') {
      const entry = this.requests.get(message.params.requestId);
      if (entry) {
        entry.failed = true;
        entry.errorText = redactText(message.params.errorText || '');
        if (!this.network.includes(entry)) this.network.push(entry);
        if (this.network.length > NETWORK_LIMIT) this.network.shift();
        this.requests.delete(message.params.requestId);
      }
      return;
    }
    if (message.method === 'Network.loadingFinished') {
      this.requests.delete(message.params.requestId);
      return;
    }
    if (message.method === 'Network.responseReceived') {
      const entry = this.requests.get(message.params.requestId);
      if (!entry) return;
      entry.status = message.params.response.status;
      entry.type = message.params.type || entry.type;
      this.network.push(entry);
      if (this.network.length > NETWORK_LIMIT) this.network.shift();
    }
  }

  /* -------------------------------------------------------------------------------------------
   * Web P0 network collection (docs/network-p0.md §3/§4/§7 §13).
   *
   * The Runtime is the only place that talks CDP for this tier. Everything below maps one CDP
   * event to one immutable normalized event in `this.net` (a per-scope NetworkStore) and keeps the
   * legacy `this.requests`/`this.network` buffers untouched so `browser_network`, P6/P21 and the T2
   * `networkDelta` assertions keep their historical shapes.
   * ----------------------------------------------------------------------------------------- */

  /** Document navigation-guard patterns: the only Fetch rules that always stay enabled. */
  #netDocumentPatterns() {
    return [{ urlPattern: '*', resourceType: 'Document', requestStage: 'Request' }];
  }

  /** One merged `Fetch.enable` configuration (guard + active rules). Never `Fetch.disable`. */
  async #netSyncFetch(signal) {
    if (!this.cdp || this.cdp.closed) return { ok: false, reason: 'cdp-closed' };
    const patterns = network.buildFetchPatterns({ documentPatterns: this.#netDocumentPatterns(), rules: this.netCtl.rules });
    const key = JSON.stringify(patterns);
    if (key === this.netFetchKey) return { ok: true, patterns, changed: false };
    try {
      await this.cdp.send('Fetch.enable', { patterns }, { signal, timeoutMs: 5000 });
      this.netFetchKey = key;
      this.netFetchPatterns = patterns;
      return { ok: true, patterns, changed: true };
    } catch (error) {
      const classified = asBrowserError(error);
      return { ok: false, patterns, reason: classified.code };
    }
  }

  /** Page-level auto-attach for worker / OOPIF collection (R1-6 order: listener → enable → resume). */
  async #netArmAutoAttach(signal) {
    if (!this.cdp || this.cdp.closed) return { ok: false, reason: 'cdp-closed' };
    try {
      await this.cdp.send('Target.setAutoAttach', {
        autoAttach: true,
        waitForDebuggerOnStart: true,
        flatten: true,
        // Only page-owned children are auto-attached. Attaching shared/service workers here pauses
        // them at start (they need `runIfWaitingForDebugger` before they may run), which is
        // observable to the page: `serviceWorker.register()`/`controller` then fails. Collection
        // must never change page semantics, so those two are left alone (documented NOT_RUN).
        filter: [
          { type: 'worker', exclude: false },
          // Shared workers are page-scoped enough to be attached here: pausing them at start does
          // not touch a page API (the fixture's `#net-shared-worker` still reports done:1).
          { type: 'shared_worker', exclude: false },
          { type: 'iframe', exclude: false },
        ],
      }, { signal, timeoutMs: 5000 });
      return { ok: true };
    } catch (error) {
      return { ok: false, reason: asBrowserError(error).code };
    }
  }

  async #netDisarmAutoAttach() {
    if (!this.cdp || this.cdp.closed) return;
    try {
      await this.cdp.send('Target.setAutoAttach', { autoAttach: false, waitForDebuggerOnStart: false, flatten: true }, { timeoutMs: 1000 });
    } catch { /* page already gone */ }
  }

  /** `Target.attachedToTarget` / `detachedFromTarget` on the page connection. */
  #netOnTarget(message) {
    const params = message.params || {};
    if (message.method === 'Target.detachedFromTarget') {
      this.netTargets.delete(params.sessionId);
      return;
    }
    const info = params.targetInfo || {};
    const childSessionId = params.sessionId;
    const type = String(info.type || '');
    const wanted = ['worker', 'shared_worker', 'service_worker', 'iframe'].includes(type);
    // R1-21: being attached to *this* Runtime's page session is itself the scope proof (one
    // Runtime+store per workspace scope), so shared/service workers are collected too. The shared
    // case is only advisory-noted: one cross-page shared worker may appear in several scopes.
    this.netTargets.set(childSessionId, {
      targetId: info.targetId || null, type, url: info.url || '',
      attribution: 'page-attached',
      openerId: info.openerId || null, parentFrameId: info.parentFrameId || null,
    });
    if ((type === 'shared_worker' || type === 'service_worker') && !this.net.issues.includes('workers-shared-attribution')) {
      this.net.issues.push('workers-shared-attribution');
    }
    const cdp = this.cdp;
    void (async () => {
      let ok = true;
      try {
        if (wanted) {
          await cdp.send('Network.enable', { maxTotalBufferSize: 5000000 }, { sessionId: childSessionId, timeoutMs: 5000 });
          await cdp.send('Runtime.enable', {}, { sessionId: childSessionId, timeoutMs: 5000 });
          // Nested workers: replicate auto-attach on the child session.
          await cdp.send('Target.setAutoAttach', { autoAttach: true, waitForDebuggerOnStart: true, flatten: true }, { sessionId: childSessionId, timeoutMs: 5000 })
            .catch(() => {});
        }
      } catch {
        ok = false;
      } finally {
        // A worker must never stay frozen: resume first, then detach if setup failed.
        try { await cdp.send('Runtime.runIfWaitingForDebugger', {}, { sessionId: childSessionId, timeoutMs: 5000 }); } catch { /* ignore */ }
        if (!ok) {
          try { await cdp.send('Target.detachFromTarget', { sessionId: childSessionId }, { timeoutMs: 1000 }); } catch { /* ignore */ }
          this.netTargets.delete(childSessionId);
        }
      }
    })();
  }

  #netWall(targetId, params) {
    const seconds = Number.isFinite(params && params.timestamp) ? params.timestamp : null;
    if (Number.isFinite(params && params.wallTime)) {
      this.net.setAnchor(targetId, seconds, Math.round(params.wallTime * 1000));
      return Math.round(params.wallTime * 1000);
    }
    return this.net.wallMsFor(targetId, seconds);
  }

  #netHop(keyOf) {
    return this.netHops.get(keyOf) || 0;
  }

  #netBumpHop(keyOf) {
    const next = (this.netHops.get(keyOf) || 0) + 1;
    this.netHops.set(keyOf, next);
    return next;
  }

  /** The single CDP → event mapping (§3.1). Every branch emits normalized, immutable events. */
  #netOnEvent(message) {
    const params = message.params || {};
    const cdpSessionId = message.sessionId || null;
    let attribution = null;
    if (cdpSessionId) {
      const child = this.netTargets.get(cdpSessionId);
      // Only sessions this Runtime attached are ours; an unknown session cannot be attributed.
      if (!child) return;
      attribution = child.attribution || 'page-attached';
    }
    const targetId = cdpSessionId ? (this.netTargets.get(cdpSessionId) || {}).targetId || null : (this.page ? this.page.targetId : null);
    const keyOf = [targetId || '', cdpSessionId || '', params.requestId || ''].join('\u0000');
    const hopOf = (requestId) => this.#netHop([targetId || '', cdpSessionId || '', requestId || ''].join('\u0000'));
    const common = { targetId, cdpSessionId, requestId: params.requestId || null, attribution };

    if (message.method === 'Network.requestWillBeSent') {
      const request = params.request || {};
      const wallMs = this.#netWall(targetId, params);
      // Navigation counter: the first Document request of a session is navId 1, each new loaderId
      // (a real navigation) increments it, so `navId` increases monotonically (C15).
      if (!this.netNavIds) this.netNavIds = new Map();
      if (params.type === 'Document' && params.loaderId && !this.netNavIds.has(params.loaderId)) {
        this.netNavIds.set(params.loaderId, this.netNavIds.size + 1);
      }
      const hop = hopOf(params.requestId);
      if (params.redirectResponse) {
        const previous = this.netReq.get(keyOf) || {};
        this.net.add({
          ...common, kind: 'http', phase: 'redirect', hopId: hop,
          ts: { wallMs, cdpSeconds: params.timestamp },
          url: params.redirectResponse.url || previous.url || '',
          method: previous.method || request.method || null,
          resourceType: params.type || null,
          status: Number.isInteger(params.redirectResponse.status) ? params.redirectResponse.status : null,
          fromCache: params.redirectResponse.fromDiskCache === true || params.redirectResponse.fromPrefetchCache === true,
          redirect: {
            from: params.redirectResponse.url || previous.url || '',
            to: request.url || '',
            status: Number.isInteger(params.redirectResponse.status) ? params.redirectResponse.status : null,
            fromSeq: previous.requestSeq === undefined ? null : previous.requestSeq,
            toSeq: null,
          },
          frameId: params.frameId || null,
          loaderId: params.loaderId || null,
          navId: (params.loaderId && this.netNavIds ? this.netNavIds.get(params.loaderId) : null) || this.navigationCount || null,
          documentURL: params.documentURL || this.url || null,
          initiator: previous.initiator || params.initiator || null,
        });
      }
      const resolvedHop = params.redirectResponse ? this.#netBumpHop(keyOf) : hop;
      const emitted = this.net.add({
        ...common, kind: 'http', phase: 'request', hopId: resolvedHop,
        ts: { wallMs, cdpSeconds: params.timestamp },
        url: request.url || '',
        method: request.method || null,
        resourceType: params.type || null,
        frameId: params.frameId || null,
        loaderId: params.loaderId || null,
        navId: (params.loaderId && this.netNavIds ? this.netNavIds.get(params.loaderId) : null) || this.navigationCount || null,
        documentURL: params.documentURL || this.url || null,
        initiator: params.initiator || null,
        sizes: { requestHeaders: null },
      });
      this.netReq.set(keyOf, {
        hop: resolvedHop, method: request.method || null, url: request.url || '',
        hasPostData: request.hasPostData === true, postData: request.postData || null,
        requestSeq: emitted ? emitted.seq : null, initiator: params.initiator || null,
        resourceType: params.type || null, wallMs,
      });
      return;
    }
    if (message.method === 'Network.requestWillBeSentExtraInfo') {
      this.net.setHeaders({ targetId, cdpSessionId, requestId: params.requestId, hopId: hopOf(params.requestId), kind: 'request', headers: params.headers || {} });
      return;
    }
    if (message.method === 'Network.responseReceivedExtraInfo') {
      this.net.setHeaders({ targetId, cdpSessionId, requestId: params.requestId, hopId: hopOf(params.requestId), kind: 'response', headers: params.headers || {} });
      const info = this.netReq.get(keyOf);
      if (info && Number.isInteger(params.statusCode)) info.statusCode = params.statusCode;
      return;
    }
    if (message.method === 'Network.requestServedFromCache') {
      this.netCacheHits.add(keyOf);
      return;
    }
    if (message.method === 'Network.responseReceived') {
      const response = params.response || {};
      const info = this.netReq.get(keyOf) || {};
      const statusOf = Number.isInteger(params.statusCode) ? params.statusCode : (Number.isInteger(response.status) ? response.status : null);
      // 3xx fallback: when Chromium follows a redirect internally it may not deliver a
      // `requestWillBeSent.redirectResponse` on this connection (it does for documents, not always
      // for fetch/XHR). A redirect row + a hop bump keeps the chain (and the dependency edges built
      // from it) complete either way (C25/C32).
      if (statusOf !== null && statusOf >= 300 && statusOf < 400 && statusOf !== 304) {
        const location = response.headers && (response.headers.location || response.headers.Location);
        if (location) {
          let nextUrl = String(location);
          try { nextUrl = new URL(String(location), response.url || info.url || this.url || undefined).toString(); } catch { /* keep raw */ }
          const hop = hopOf(params.requestId);
          this.net.add({
            ...common, kind: 'http', phase: 'redirect', hopId: hop,
            ts: { wallMs: this.#netWall(targetId, params), cdpSeconds: params.timestamp },
            url: response.url || info.url || '',
            method: info.method || null,
            resourceType: params.type || info.resourceType || null,
            status: statusOf,
            statusText: response.statusText || null,
            redirect: { from: response.url || info.url || '', to: nextUrl, status: statusOf },
            frameId: params.frameId || null,
            loaderId: params.loaderId || null,
            documentURL: params.documentURL || this.url || null,
            initiator: info.initiator || null,
            basis: 'cdp-redirect',
          });
          this.netReq.set(keyOf, { ...info, redirectTo: nextUrl, redirectFrom: response.url || info.url || '', hop: hop + 1 });
          this.#netBumpHop(keyOf);
        }
      }
      const timing = network.normalizeTiming(response.timing || {}, {
        responseSeconds: Number.isFinite(params.timestamp) ? params.timestamp : null,
      });
      this.net.add({
        ...common, kind: 'http', phase: 'response', hopId: hopOf(params.requestId),
        ts: { wallMs: this.#netWall(targetId, params), cdpSeconds: params.timestamp },
        url: response.url || info.url || '',
        method: info.method || null,
        resourceType: params.type || info.resourceType || null,
        status: Number.isInteger(params.statusCode) ? params.statusCode : (Number.isInteger(response.status) ? response.status : null),
        statusText: response.statusText || null,
        mimeType: response.mimeType || null,
        protocol: response.protocol || null,
        fromCache: response.fromDiskCache === true || response.fromPrefetchCache === true || this.netCacheHits.has(keyOf),
        frameId: params.frameId || null,
        loaderId: params.loaderId || null,
        documentURL: params.documentURL || this.url || null,
        initiator: info.initiator || null,
        timing,
        sizes: {
          requestHeaders: null,
          responseHeaders: null,
          requestBody: null,
          responseBody: Number.isInteger(response.decodedBodySize) ? response.decodedBodySize : null,
          encoded: Number.isInteger(response.encodedDataLength) ? response.encodedDataLength : null,
          decoded: Number.isInteger(response.decodedBodySize) ? response.decodedBodySize : null,
        },
      });
      const record = this.netReq.get(keyOf) || info;
      record.responseStatus = Number.isInteger(response.status) ? response.status : null;
      record.mimeType = response.mimeType || null;
      record.protocol = response.protocol || null;
      record.fromCache = response.fromDiskCache === true || response.fromPrefetchCache === true || this.netCacheHits.has(keyOf);
      // The finished event must carry the complete `timing` object (C12 asserts `timing.*Ms`) and
      // correlation ids are derivable from the request headers alone — no body needed.
      record.timing = timing;
      record.decodedBodySize = Number.isInteger(response.decodedBodySize) ? response.decodedBodySize : null;
      const requestHeaders = this.net.readHeaders({ targetId, cdpSessionId, requestId: params.requestId, hopId: hopOf(params.requestId), kind: 'request' });
      record.correlationIds = network.extractCorrelationIds(
        { url: info.url || response.url || '' },
        { headers: requestHeaders.headers, hmacKey: this.net.hmacKey },
      );
      this.netReq.set(keyOf, record);
      return;
    }
    if (message.method === 'Network.dataReceived') {
      // 不逐 chunk 建事件（§3.1）；累计到 loadingFinished 的 sizes。
      const info = this.netReq.get(keyOf) || {};
      info.dataLength = (info.dataLength || 0) + (Number.isInteger(params.dataLength) ? params.dataLength : 0);
      info.encodedDataLength = (info.encodedDataLength || 0) + (Number.isInteger(params.encodedDataLength) ? params.encodedDataLength : 0);
      info.dataChunks = (info.dataChunks || 0) + 1;
      this.netReq.set(keyOf, info);
      return;
    }
    if (message.method === 'Network.loadingFailed') {
      const info = this.netReq.get(keyOf) || {};
      this.net.add({
        ...common, kind: 'http', phase: 'failed', hopId: hopOf(params.requestId),
        ts: { wallMs: this.#netWall(targetId, params), cdpSeconds: params.timestamp },
        url: info.url || '',
        method: info.method || null,
        resourceType: params.type || info.resourceType || null,
        frameId: params.frameId || null,
        loaderId: params.loaderId || null,
        documentURL: params.documentURL || this.url || null,
        failed: true,
        errorText: params.errorText || null,
        errorCode: params.blockedReason ? String(params.blockedReason) : (params.errorText ? String(params.errorText) : null),
        blockedReason: params.blockedReason || null,
        canceled: params.canceled === true,
        initiator: info.initiator || null,
      });
      if (this.net.config.captureBodies) this.net.noteBodyUnavailable();
      this.netReq.delete(keyOf);
      return;
    }
    if (message.method === 'Network.loadingFinished') {
      const info = this.netReq.get(keyOf) || {};
      this.netReq.delete(keyOf);
      // Emit `finished` immediately with the full timing/sizes: waiting for the body would delay the
      // whole timeline (and its `timing.*Ms`) by up to the body-read timeout. Bodies are captured in
      // the background; `detail`/`business` read them from the store afterwards (R1-11).
      const timing = info.timing ? { ...info.timing } : network.emptyTiming();
      if (Number.isFinite(timing.responseTimeMs) && Number.isFinite(timing.requestTimeMs)) {
        timing.totalMs = Math.round((timing.responseTimeMs - timing.requestTimeMs) * 1000) / 1000;
      }
      this.net.add({
        ...common, kind: 'http', phase: 'finished', hopId: hopOf(params.requestId),
        ts: { wallMs: this.#netWall(targetId, params), cdpSeconds: params.timestamp },
        url: info.url || '',
        method: info.method || null,
        resourceType: info.resourceType || null,
        status: info.responseStatus === undefined ? null : info.responseStatus,
        mimeType: info.mimeType || null,
        protocol: info.protocol || null,
        fromCache: info.fromCache === true,
        frameId: params.frameId || null,
        loaderId: params.loaderId || null,
        documentURL: params.documentURL || this.url || null,
        initiator: info.initiator || null,
        timing,
        sizes: {
          encoded: Number.isInteger(params.encodedDataLength) ? params.encodedDataLength : info.encodedDataLength || null,
          responseBody: info.decodedBodySize === undefined ? null : info.decodedBodySize,
        },
        correlationIds: info.correlationIds || [],
        stepIds: [],
      });
      const bodyKey = [targetId || '', cdpSessionId || '', params.requestId || '', hopOf(params.requestId)].join('\u0000');
      const task = this.#netCaptureBodies({ targetId, cdpSessionId, requestId: params.requestId, hopId: hopOf(params.requestId), info })
        .catch(() => { })
        .finally(() => { if (this.netBodyPending) this.netBodyPending.delete(bodyKey); });
      if (!this.netBodyPending) this.netBodyPending = new Map();
      this.netBodyPending.set(bodyKey, task);
      return;
    }
    // ---- WebSocket ----
    if (message.method === 'Network.webSocketCreated') {
      if (!this.netWsUrls) this.netWsUrls = new Map();
      if (params.url) this.netWsUrls.set(params.requestId, String(params.url));
      this.net.add({
        ...common, kind: 'ws', phase: 'ws-created', hopId: hopOf(params.requestId),
        ts: { wallMs: this.#netWall(targetId, params), cdpSeconds: params.timestamp },
        url: params.url || '', resourceType: 'WebSocket', documentURL: params.documentURL || this.url || null,
        initiator: params.initiator || null,
        ws: { url: params.url || '', openedAt: Date.now(), direction: null, opcode: null },
      });
      return;
    }
    if (message.method === 'Network.webSocketWillSendHandshakeRequest') {
      const request = params.request || {};
      this.net.setHeaders({ targetId, cdpSessionId, requestId: params.requestId, hopId: hopOf(params.requestId), kind: 'request', headers: request.headers || {} });
      this.net.add({
        ...common, kind: 'ws', phase: 'ws-handshake', hopId: hopOf(params.requestId),
        ts: { wallMs: this.#netWall(targetId, params), cdpSeconds: params.timestamp },
        url: this.netReq.get(keyOf) ? this.netReq.get(keyOf).url : '', resourceType: 'WebSocket',
        ws: { direction: null, opcode: null, handshake: { status: null, statusText: null, headers: request.headers || null } },
      });
      return;
    }
    if (message.method === 'Network.webSocketHandshakeResponseReceived') {
      const response = params.response || {};
      this.net.setHeaders({ targetId, cdpSessionId, requestId: params.requestId, hopId: hopOf(params.requestId), kind: 'response', headers: response.headers || {} });
      this.net.add({
        ...common, kind: 'ws', phase: 'ws-handshake', hopId: hopOf(params.requestId),
        ts: { wallMs: this.#netWall(targetId, params), cdpSeconds: params.timestamp },
        url: response.url || (this.netWsUrls && this.netWsUrls.get(params.requestId)) || '', resourceType: 'WebSocket', protocol: response.protocol || null,
        status: Number.isInteger(response.status) ? response.status : null,
        statusText: response.statusText || null,
        ws: { direction: null, opcode: null, protocol: response.protocol || null, handshake: { status: Number.isInteger(response.status) ? response.status : null, statusText: response.statusText || null, headers: response.headers || null } },
      });
      return;
    }
    if (message.method === 'Network.webSocketFrameSent' || message.method === 'Network.webSocketFrameReceived') {
      const response = params.response || {};
      if (!this.netWsUrls) this.netWsUrls = new Map();
      const wsUrl = this.netWsUrls.get(params.requestId) || '';
      const opcode = Number.isInteger(response.opcode) ? response.opcode : null;
      const rawPayload = typeof response.payloadData === 'string' ? response.payloadData : '';
      let payload = rawPayload;
      let payloadOmitted = false;
      if (opcode !== 1) {
        // 非文本帧通常是 base64：按 opcode 解码后只保留字节数（R1-9/R1-12）。
        let bytes = 0;
        try { bytes = Buffer.from(rawPayload, 'base64').length; } catch { bytes = 0; }
        payload = '';
        payloadOmitted = true;
        this.net.add({
          ...common, kind: 'ws', url: wsUrl, phase: message.method === 'Network.webSocketFrameSent' ? 'ws-send' : 'ws-receive', hopId: hopOf(params.requestId),
          ts: { wallMs: this.#netWall(targetId, params), cdpSeconds: params.timestamp },
          resourceType: 'WebSocket',
          ws: { direction: message.method === 'Network.webSocketFrameSent' ? 'send' : 'receive', opcode, payload: null, payloadBytes: bytes, payloadOmitted },
        });
        return;
      }
      this.net.add({
        ...common, kind: 'ws', url: wsUrl, phase: message.method === 'Network.webSocketFrameSent' ? 'ws-send' : 'ws-receive', hopId: hopOf(params.requestId),
        ts: { wallMs: this.#netWall(targetId, params), cdpSeconds: params.timestamp },
        resourceType: 'WebSocket',
        ws: { direction: message.method === 'Network.webSocketFrameSent' ? 'send' : 'receive', opcode, payload },
      });
      void payloadOmitted;
      return;
    }
    if (message.method === 'Network.webSocketFrameError') {
      this.net.add({
        ...common, kind: 'ws', phase: 'ws-error', hopId: hopOf(params.requestId),
        ts: { wallMs: this.#netWall(targetId, params), cdpSeconds: params.timestamp },
        resourceType: 'WebSocket', failed: true,
        ws: { direction: null, opcode: null, errorMessage: params.errorMessage || null },
      });
      return;
    }
    if (message.method === 'Network.webSocketClosed') {
      this.net.add({
        ...common, kind: 'ws', phase: 'ws-closed', hopId: hopOf(params.requestId),
        ts: { wallMs: this.#netWall(targetId, params), cdpSeconds: params.timestamp },
        resourceType: 'WebSocket',
        ws: { direction: null, opcode: null, closedAt: Date.now() },
      });
      return;
    }
    // ---- SSE ----
    if (message.method === 'Network.eventSourceMessageReceived') {
      this.net.add({
        ...common, kind: 'sse', phase: 'sse-message', hopId: hopOf(params.requestId),
        ts: { wallMs: this.#netWall(targetId, params), cdpSeconds: params.timestamp },
        url: '', resourceType: 'EventSource',
        sse: { eventName: params.eventName || null, eventId: params.eventId || null, data: params.data === undefined ? null : params.data },
      });
    }
  }

  /**
   * Body capture for one finished request (R1-11): three states — `captured` / `empty` /
   * `unavailable`. GET without postData, HEAD/204/304 are legitimately `empty` and must NOT call
   * `getRequestPostData`. Bounded by `netBodyTimeoutMs` so a slow target never stalls the event.
   */
  async #netCaptureBodies({ targetId, cdpSessionId, requestId, hopId, info }) {
    const cdp = this.cdp;
    if (!cdp || cdp.closed) return { requestBytes: null, responseBytes: null };
    // A stopped/frozen session must be fully frozen: no CDP body read and no counter movement
    // (`bodies`/`bytes` used to keep growing after stop, which made the counters observable as
    // "not frozen"). Events buffered while stopped are counted by `counters.preSession` instead.
    if (!this.net.running) return { requestBytes: null, responseBytes: null };
    const config = this.net.config;
    const options = { sessionId: cdpSessionId || undefined, timeoutMs: this.netBodyTimeoutMs };
    const method = String(info.method || 'GET').toUpperCase();
    const status = Number.isInteger(info.responseStatus) ? info.responseStatus : null;
    const out = { requestBytes: null, responseBytes: null };
    const requestHeaders = this.net.readHeaders({ targetId, cdpSessionId, requestId, hopId, kind: 'request' });
    const requestType = requestHeaders.headers['content-type'] || null;

    /**
     * Sanitize before storing (C45 / §8.4): a JSON/text/urlencoded body is field-masked here, at
     * capture time, so the raw value never reaches the store, detail, search, JSONL or HAR.
     * Binary bodies keep their bytes as base64 (detail returns `encoding:"base64"`).
     */
    const storeBody = (kind, raw, contentType) => {
      const sanitized = network.sanitizeBody(raw, contentType, { maskRules: config.maskRules });
      if (sanitized.payloadOmitted && sanitized.kind === 'binary') {
        const base64 = Buffer.isBuffer(raw) ? raw.toString('base64') : Buffer.from(String(raw ?? ''), 'base64').toString('base64');
        return this.net.addBody({
          targetId, cdpSessionId, requestId, hopId, kind, state: base64 === '' ? 'empty' : 'captured',
          data: base64, base64Encoded: true, contentType, redacted: 'none', payloadOmitted: false,
        });
      }
      return this.net.addBody({
        targetId, cdpSessionId, requestId, hopId, kind,
        state: sanitized.text === '' ? 'empty' : 'captured',
        data: sanitized.text, contentType, redacted: sanitized.redacted, payloadOmitted: false,
      });
    };

    // ---- request body (R1-11: GET/HEAD never call getRequestPostData) ----
    if (config.captureBodies) {
      const noBodyMethod = method === 'GET' || method === 'HEAD';
      if (typeof info.postData === 'string' && info.postData !== '') {
        const stored = storeBody('request', info.postData, requestType);
        out.requestBytes = stored ? stored.bytes : null;
      } else if (noBodyMethod || info.hasPostData !== true) {
        this.net.addBody({ targetId, cdpSessionId, requestId, hopId, kind: 'request', state: 'empty', contentType: requestType });
        out.requestBytes = 0;
      } else {
        try {
          const post = await cdp.send('Network.getRequestPostData', { requestId }, options);
          const text = post && typeof post.postData === 'string' ? post.postData : '';
          const stored = text === ''
            ? this.net.addBody({ targetId, cdpSessionId, requestId, hopId, kind: 'request', state: 'empty', contentType: requestType })
            : storeBody('request', text, requestType);
          out.requestBytes = stored ? stored.bytes : null;
        } catch (error) {
          void error;
          this.net.addBody({ targetId, cdpSessionId, requestId, hopId, kind: 'request', state: 'unavailable' });
        }
      }
    }

    // ---- response body ----
    if (config.captureBodies) {
      const emptyByDefinition = method === 'HEAD' || status === 204 || status === 304 || info.fromCache === true;
      if (emptyByDefinition) {
        this.net.addBody({ targetId, cdpSessionId, requestId, hopId, kind: 'response', state: 'empty', contentType: info.mimeType || null });
        out.responseBytes = 0;
      } else {
        try {
          const body = await cdp.send('Network.getResponseBody', { requestId }, options);
          const text = body && typeof body.body === 'string' ? body.body : '';
          const base64Encoded = body && body.base64Encoded === true;
          const stored = text === ''
            ? this.net.addBody({ targetId, cdpSessionId, requestId, hopId, kind: 'response', state: 'empty', contentType: info.mimeType || null })
            // `getResponseBody` returns the decompressed text, so gzip responses are masked and
            // stored as plain JSON/text (C2).
            : storeBody('response', base64Encoded ? Buffer.from(text, 'base64') : text, info.mimeType || null);
          out.responseBytes = stored ? stored.bytes : null;
        } catch (error) {
          void error;
          this.net.addBody({ targetId, cdpSessionId, requestId, hopId, kind: 'response', state: 'unavailable' });
        }
      }
    }
    return out;
  }

  /**
   * The single Fetch dispatcher (R1-8): guard first, then user rules, exactly one termination per
   * paused request. `Fetch.disable` is never called — the guard configuration must survive.
   */
  async #onFetchPaused(message) {
    const cdp = this.cdp;
    const params = message.params || {};
    const requestId = params.requestId;
    const request = params.request || {};
    const cdpSessionId = message.sessionId || null;
    const terminate = (method, payload) => {
      const target = this.cdp;
      if (!target || target.closed) return Promise.resolve();
      return target.send(method, { requestId, ...payload }, { sessionId: cdpSessionId || undefined, timeoutMs: 5000 })
        .catch(() => { });
    };
    if (!cdp || cdp.closed) return;
    const decision = network.decidePausedAction({ resourceType: params.resourceType, request, rules: this.netCtl.rules });

    if (decision.action === 'guard') {
      try {
        await validateTarget(request.url, { origins: [...this.origins] });
        await terminate('Fetch.continueRequest', {});
      } catch (error) {
        this.navigationError = new BrowserError('NAV_FAILED', error.message, { url: redactUrl(request.url) });
        this.setError(this.navigationError.message, { actionId: null, target: redactUrl(request.url) });
        await terminate('Fetch.failRequest', { errorReason: 'BlockedByClient' });
      }
      return;
    }
    if (decision.action === 'continue') {
      await terminate('Fetch.continueRequest', {});
      return;
    }
    const rule = decision.rule;
    this.netCtl.noteHit(rule.id);
    const behavior = rule.behavior;
    if (decision.action === 'hold') {
      try {
        this.netCtl.holdRequest({
          requestId: `fee-${cdpSessionId || 'main'}-${requestId}`, url: request.url,
          method: request.method, resourceType: params.resourceType, ruleId: rule.id,
        });
        this.netPending.set(`${cdpSessionId || 'main'}\u0000${requestId}`, { params, cdpSessionId, requestId });
        this.#netArmHoldSweep();
      } catch (error) {
        const classified = asBrowserError(error);
        if (classified.code === 'NET_QUOTA_EXCEEDED') await terminate('Fetch.continueRequest', {});
      }
      return;
    }
    if (behavior.kind === 'block' || behavior.kind === 'fail') {
      // A Fetch-level failure never reaches the network stack, so Chromium emits no
      // `Network.loadingFailed` for it. The collector performed the action, so it records the
      // request + failed pair itself (url/method/type come from the paused params) — otherwise the
      // page sees a failure with no network evidence (C36/C39).
      const request = params.request || {};
      const wallMs = Date.now();
      const blockedText = behavior.kind === 'block' ? 'net::ERR_BLOCKED_BY_CLIENT.Inspector' : 'net::ERR_FAILED';
      const base = {
        kind: 'http',
        targetId: params.targetId || this.netCtl.currentTargetId || null,
        cdpSessionId: cdpSessionId || null,
        requestId,
        url: request.url || '', method: request.method || null,
        resourceType: params.resourceType || null,
        frameId: params.frameId || null,
        attribution: cdpSessionId ? 'child-session' : 'page-attached',
        ts: { wallMs, cdpSeconds: null },
        documentURL: this.url || null,
      };
      const alreadyKnown = this.net.events.some((item) => item.requestId === requestId);
      if (!alreadyKnown) {
        // Only synthesize when Chromium itself never reported the request (Fetch-level failures are
        // invisible to the Network domain). If it did, its own request/failed pair is authoritative.
        try { this.net.add({ ...base, phase: 'request' }); } catch { /* best effort */ }
        try {
          this.net.add({ ...base, phase: 'failed', failed: true, errorText: blockedText, errorCode: blockedText });
        } catch { /* best effort */ }
      }
      // The request MUST be released even if recording failed, otherwise the page hangs forever.
      try {
        await terminate('Fetch.failRequest', { errorReason: behavior.kind === 'block' ? 'BlockedByClient' : (behavior.errorReason || 'Aborted') });
      } catch { /* terminate already falls back to continue on its own path */ }
      return;
    }
    if (behavior.kind === 'delay') {
      const delay = Math.max(0, Math.min(behavior.delayMs || 0, 60000));
      setTimeout(() => { terminate('Fetch.continueRequest', {}); }, delay);
      return;
    }
    if (behavior.kind === 'modify-request') {
      const payload = {};
      if (behavior.headers) payload.headers = Object.entries(behavior.headers).map(([name, value]) => ({ name, value }));
      if (behavior.body !== null) payload.postData = Buffer.from(behavior.body, 'utf8').toString('base64');
      if (behavior.url) {
        // R1-8：改 URL 必须重做导航安全校验。
        try {
          await validateTarget(behavior.url, { origins: [...this.origins] });
          payload.url = behavior.url;
        } catch {
          await terminate('Fetch.failRequest', { errorReason: 'BlockedByClient' });
          return;
        }
      }
      await terminate('Fetch.continueRequest', payload);
      return;
    }
    if (behavior.kind === 'fulfill') {
      let body = behavior.body;
      if (body === null && behavior.fromRequestId) {
        const stored = this.net.readBody({ requestId: behavior.fromRequestId, kind: 'response' });
        if (stored) body = stored.data;
      }
      const headers = Object.entries(network.stripHopByHopHeaders(behavior.headers || {})).map(([name, value]) => ({ name, value }));
      if (body !== null && !headers.some((header) => header.name.toLowerCase() === 'content-type')) {
        headers.push({ name: 'content-type', value: 'application/json' });
      }
      // Chromium rejects a `responseCode` without a valid status phrase (299 → "Invalid http status
      // code or phrase"). Supplying `responsePhrase` makes any 3-digit code acceptable, and a failed
      // fulfill always falls back to `continueRequest` so the page can never hang (C40).
      const code = Number.isInteger(behavior.status) && behavior.status >= 100 && behavior.status <= 599 ? behavior.status : 200;
      try {
        await terminate('Fetch.fulfillRequest', {
          responseCode: code,
          responsePhrase: behavior.statusText || 'Mocked',
          responseHeaders: headers,
          body: Buffer.from(body === null ? '' : body, 'utf8').toString('base64'),
        });
      } catch {
        await terminate('Fetch.continueRequest', {});
      }
      return;
    }
    if (behavior.kind === 'modify-response') {
      // 响应修改（R1-7）：只有 Chrome 支持 Fetch.continueResponse 时才声明能力。
      if (this.netCtl.responseModification === false) {
        if (!this.net.issues.includes('response-modification-unsupported')) this.net.issues.push('response-modification-unsupported');
        await terminate('Fetch.continueRequest', {});
        return;
      }
      await terminate('Fetch.continueRequest', {});
      return;
    }
    await terminate('Fetch.continueRequest', {});
  }

  /** Held requests must never hang the page: every hold auto-continues after holdTimeoutMs. */
  #netArmHoldSweep() {
    if (this.netHoldTimer) return;
    this.netHoldTimer = setInterval(() => { this.#netSweepHolds(); }, 1000);
    if (typeof this.netHoldTimer.unref === 'function') this.netHoldTimer.unref();
  }

  #netSweepHolds() {
    const expired = this.netCtl.expiredHolds();
    for (const entry of expired) {
      this.netCtl.releaseHold(entry.requestId, { timedOut: true });
      this.#netContinueHeld(entry.requestId, { kind: 'continue' });
    }
    if (this.netCtl.held.size === 0 && this.netHoldTimer) {
      clearInterval(this.netHoldTimer);
      this.netHoldTimer = null;
    }
  }

  #netContinueHeld(holdId, then) {
    for (const [key, pending] of [...this.netPending.entries()]) {
      if (`fee-${pending.cdpSessionId || 'main'}-${pending.requestId}` !== String(holdId)) continue;
      this.netPending.delete(key);
      const terminate = (method, payload) => {
        const target = this.cdp;
        if (!target || target.closed) return;
        target.send(method, { requestId: pending.requestId, ...payload }, {
          sessionId: pending.cdpSessionId || undefined, timeoutMs: 5000,
        }).catch(() => { });
      };
      if (then.kind === 'fail') { terminate('Fetch.failRequest', { errorReason: then.errorReason || 'Aborted' }); continue; }
      if (then.kind === 'fulfill') {
        const headers = Object.entries(network.stripHopByHopHeaders(then.headers || {})).map(([name, value]) => ({ name, value }));
        terminate('Fetch.fulfillRequest', {
          responseCode: then.status || 200, responseHeaders: headers,
          body: Buffer.from(then.body === null ? '' : then.body, 'utf8').toString('base64'),
        });
        continue;
      }
      terminate('Fetch.continueRequest', {});
    }
  }

  /** stop / reset / close: release every held request and restore plain network conditions. */
  async #netReleaseAllHeld() {
    const held = this.netCtl.listHeld();
    for (const entry of held) this.#netContinueHeld(entry.requestId, { kind: 'continue' });
    this.netCtl.held.clear();
    this.netPending.clear();
    if (this.netHoldTimer) { clearInterval(this.netHoldTimer); this.netHoldTimer = null; }
    return held.length;
  }

  /* ---- shared view: projections ------------------------------------------------------------ */

  /** Derived mode: exact preset match, otherwise `custom` (never an independent stored flag). */
  viewMode() { return viewModeFor(this.view.width, this.view.height); }

  /** Pure-JSON `view` projection (safe for tool values, HTTP `ui.view` and `state.view`). */
  viewProjection() {
    const view = this.view;
    return {
      version: 1,
      mode: this.viewMode(),
      x: view.x,
      y: view.y,
      width: view.width,
      height: view.height,
      scale: view.scale,
      source: view.source,
      revision: view.revision,
    };
  }

  /** `observed` projection: null until a real readback; unknown values stay null, never guessed. */
  observedProjection() {
    const observed = this.observed;
    if (!observed) return null;
    return {
      x: observed.x,
      y: observed.y,
      width: observed.width,
      height: observed.height,
      contentWidth: observed.contentWidth,
      contentHeight: observed.contentHeight,
      pageDevicePixelRatio: observed.pageDevicePixelRatio,
      visualViewportScale: observed.visualViewportScale,
      observedAt: observed.observedAt,
      source: 'Page.getLayoutMetrics',
    };
  }

  /** Freshness/identity companions for the cached view (docs/viewport-control.md §3.1). */
  viewMeta() {
    const observed = this.observed;
    return {
      runtimeId: this.runtimeId,
      observedAt: observed ? observed.observedAt : null,
      stale: !observed || Date.now() - observed.observedAt > VIEW_LIMITS.staleAfterMs,
      originId: this.viewOriginId ?? null,
    };
  }

  /** Read-only diagnostics for `browser_viewport get` (no ensure, no CDP, no lease). */
  viewSnapshot() {
    return {
      ok: true,
      running: this.running,
      view: this.viewProjection(),
      observed: this.observedProjection(),
      viewMeta: this.viewMeta(),
    };
  }

  /* ---- shared view: observation ------------------------------------------------------------ */

  /**
   * One real `Page.getLayoutMetrics` read (plus the page DPR as evidence).
   *
   * `cssLayoutViewport.pageX/pageY` is the authoritative document scroll position and
   * `clientWidth/clientHeight` the CSS viewport size (docs/viewport-control.md §3.2). A Chromium
   * without the `css*` fields cannot prove CSS coordinates, so it is reported as UNSUPPORTED
   * instead of mixing device pixels into CSS fields.
   */
  async #readViewMetrics(signal) {
    let layout;
    try {
      layout = await this.send('Page.getLayoutMetrics', {}, signal);
    } catch (error) {
      throw this.#captureError(error, 'getLayoutMetrics');
    }
    const layoutViewport = (layout && layout.cssLayoutViewport) || {};
    const visualViewport = (layout && layout.cssVisualViewport) || {};
    const content = (layout && layout.cssContentSize) || {};
    if (!Number.isFinite(layoutViewport.clientWidth) || !Number.isFinite(layoutViewport.clientHeight)) {
      throw new BrowserError('UNSUPPORTED', '当前 Chromium 不提供 CSS layout viewport 指标（无法证明 CSS 坐标）', {
        phase: 'getLayoutMetrics', reason: 'css-layout-viewport-missing',
      });
    }
    const pick = (primary, fallback) => (Number.isFinite(primary) ? primary : fallback);
    let pageDevicePixelRatio = null;
    try {
      const evaluated = await this.send('Runtime.evaluate', {
        expression: 'window.devicePixelRatio', returnByValue: true,
      }, signal);
      const value = evaluated && evaluated.result ? evaluated.result.value : undefined;
      if (typeof value === 'number' && Number.isFinite(value) && value > 0) pageDevicePixelRatio = value;
    } catch (error) {
      if (error && error.code === 'ABORTED') throw error;
      pageDevicePixelRatio = null;
    }
    return {
      x: pick(layoutViewport.pageX, pick(visualViewport.pageX, 0)),
      y: pick(layoutViewport.pageY, pick(visualViewport.pageY, 0)),
      width: layoutViewport.clientWidth,
      height: layoutViewport.clientHeight,
      contentWidth: Number.isFinite(content.width) ? content.width : null,
      contentHeight: Number.isFinite(content.height) ? content.height : null,
      pageDevicePixelRatio,
      visualViewportScale: Number.isFinite(visualViewport.scale) ? visualViewport.scale : null,
      observedAt: Date.now(),
    };
  }

  /** Instant scroll only: the single `Runtime.evaluate` use allowed besides the DPR read. */
  async #scrollViewTo(x, y, signal) {
    const left = Number.isFinite(x) ? x : 0;
    const top = Number.isFinite(y) ? y : 0;
    await this.send('Runtime.evaluate', {
      expression: `window.scrollTo({left:${JSON.stringify(left)},top:${JSON.stringify(top)},behavior:'instant'})`,
      returnByValue: true,
    }, signal);
  }

  /** Wait for two rendered frames, bounded so a non-compositing page can never stall a set. */
  async #waitTwoFrames(signal) {
    const cdp = this.cdp;
    if (!cdp || cdp.closed) return;
    try {
      await cdp.send('Runtime.evaluate', {
        expression: 'new Promise((r) => requestAnimationFrame(() => requestAnimationFrame(() => r(true))))',
        returnByValue: true,
        awaitPromise: true,
      }, { signal, timeoutMs: 500 });
    } catch {
      // A page that never paints (or a cancelled wait) must fall through to the timed samples:
      // the bounded readback below is the authority, the frame wait is only a head start.
    }
  }

  /**
   * Bounded stable readback (docs/viewport-control.md §4.1 step 5): two frames, then at most
   * `settleMaxMs` of samples; two consecutive samples within 0.01 CSS px count as settled.
   * Settling is best effort — `settled:false` is a legal answer, never an error.
   */
  async #settleViewObservation(signal) {
    await this.#waitTwoFrames(signal);
    checkAbort(signal);
    const deadline = Date.now() + VIEW_LIMITS.settleMaxMs;
    let previous = await this.#readViewMetrics(signal);
    let settled = false;
    while (Date.now() < deadline) {
      await new Promise((resolve) => setTimeout(resolve, 50));
      checkAbort(signal);
      const next = await this.#readViewMetrics(signal);
      const stable = ['x', 'y', 'width', 'height']
        .every((key) => Math.abs(next[key] - previous[key]) <= 0.01);
      previous = next;
      if (stable) { settled = true; break; }
    }
    return { observed: previous, settled };
  }

  /**
   * Commit one observation: x/y/width/height come from the real metrics, `scale` from the patch.
   * `revision` only moves when the content actually changed; `source` records who changed it.
   */
  #commitViewObservation(observed, { source = null, originId, scale = null } = {}) {
    const view = this.view;
    let changed = false;
    if (observed) {
      this.observed = observed;
      for (const key of ['x', 'y', 'width', 'height']) {
        if (!Number.isFinite(observed[key])) continue;
        if (Math.abs(observed[key] - view[key]) > 1e-6) { view[key] = observed[key]; changed = true; }
      }
    }
    if (Number.isFinite(scale) && Math.abs(scale - view.scale) > 1e-9) {
      view.scale = scale;
      changed = true;
    }
    if (source && changed) view.source = source;
    if (originId !== undefined) this.viewOriginId = originId ?? null;
    if (changed) view.revision += 1;
    return changed;
  }

  /** One best-effort observation (page start). A failure leaves the previous facts untouched. */
  async refreshViewObservation(signal) {
    try {
      const observed = await this.#readViewMetrics(signal);
      this.#commitViewObservation(observed, { source: null });
      return observed;
    } catch (error) {
      if (error && error.code === 'ABORTED') throw error;
      return null;
    }
  }

  /**
   * Coalesced, single-flight, throttled view observation (docs/viewport-control.md §3.2).
   *
   * The page can move without any `browser_viewport set`: the page's own scripts, `scrollIntoView`,
   * a wheel/scroll from the panel, smooth scrolling or scroll snap. Without a readback the cached
   * `view.x/y` would only refresh on the next set, so the panel's X/Y inputs would show a stale
   * position (Client GUI V6.4). This schedules at most one metrics read:
   *   - **throttled**: real reads are at least `scrollPollMinMs` (200ms) apart,
   *   - **coalesced**: several requests inside one window collapse into one read,
   *   - **single-flight**: a read in flight is never stacked,
   *   - **event-driven**: only requests/actions arm it — no standing timer, so an idle page with no
   *     GUI poll costs zero CDP calls.
   *
   * `delayMs` lets a caller ask for a settling sample (`/input` schedules 50ms and 250ms).
   * A failed read keeps the previous `observed` (which then reports `stale:true`) and never invents
   * a position.
   */
  refreshViewObservationSoon({ delayMs = 0 } = {}) {
    const cdp = this.cdp;
    if (!cdp || cdp.closed) return;
    const now = Date.now();
    if (!Array.isArray(this.viewObserveDue)) this.viewObserveDue = [];
    this.viewObserveDue.push(now + Math.max(0, delayMs));
    // Two slots are the contract (immediate + settling sample); keep the queue tiny.
    if (this.viewObserveDue.length > 4) this.viewObserveDue.splice(0, this.viewObserveDue.length - 4);
    this.#armViewObservation();
  }

  #armViewObservation() {
    if (this.viewObserveTimer || this.viewObserving) return;
    if (!Array.isArray(this.viewObserveDue) || this.viewObserveDue.length === 0) return;
    const cdp = this.cdp;
    if (!cdp || cdp.closed) return;
    const now = Date.now();
    const due = Math.min(...this.viewObserveDue);
    const wait = Math.max(0, Math.max(due, this.viewObserveAt + VIEW_LIMITS.scrollPollMinMs) - now);
    this.viewObserveTimer = setTimeout(() => {
      this.viewObserveTimer = 0;
      // Consume every due time that this slot covers.
      const slot = Date.now();
      this.viewObserveDue = (this.viewObserveDue || []).filter((item) => item > slot + 5);
      this.#runViewObservation();
    }, wait);
    this.viewObserveTimer.unref?.();
  }

  #runViewObservation() {
    const cdp = this.cdp;
    if (!cdp || cdp.closed) { this.viewObserveDue = []; return; }
    // Never sample in the middle of a page operation (a set does its own bounded readback) or
    // while the page is starting/closing: defer one slot instead of racing them.
    if (this.inflight > 0 || this.starting || this.closing) {
      // One deferred slot only: never let a long operation grow the queue (it is re-armed when the
      // operation ends and a request asks again).
      if (this.viewObserveDue.length === 0) this.viewObserveDue.push(Date.now() + 100);
      else this.viewObserveDue[0] = Date.now() + 100;
      this.#armViewObservation();
      return;
    }
    this.viewObserving = true;
    this.viewObserveAt = Date.now();
    const cdpAtStart = cdp;
    this.#readViewMetrics(AbortSignal.timeout(5000))
      .then((observed) => {
        if (this.cdp !== cdpAtStart || cdpAtStart.closed || this.closing) return;
        this.#commitObservedPosition(observed);
      })
      .catch(() => { /* keep the old facts: `stale` then tells the truth */ })
      .finally(() => {
        this.viewObserving = false;
        this.#armViewObservation();
      });
  }

  /**
   * Commit a background reading: refresh `observed`/`observedAt`, and echo a *position* change into
   * `view.x/y` with `source:'page'` and `revision+1`. Width/height/scale are owned by set (which has
   * its own bounded readback), so a background sample never rewrites them; a same-value sample never
   * bumps the revision.
   */
  #commitObservedPosition(observed) {
    if (!observed) return false;
    this.observed = observed;
    const view = this.view;
    let changed = false;
    for (const key of ['x', 'y']) {
      if (!Number.isFinite(observed[key])) continue;
      if (Math.abs(observed[key] - view[key]) > 1e-6) { view[key] = observed[key]; changed = true; }
    }
    if (changed) {
      view.source = 'page';
      view.revision += 1;
    }
    return changed;
  }

  /* ---- shared view: set -------------------------------------------------------------------- */

  /**
   * Apply one validated view patch **inside** the serial queue (docs/viewport-control.md §4.1).
   *
   * The caller does the pure pre-flight and enters `run()`; the `expectedRevision` recheck happens
   * here so two concurrent patches cannot both pass it (CAS in the queue). Only a width/height
   * change sends `Emulation.setDeviceMetricsOverride` (never for scale-only or x/y-only), a scroll
   * is only sent when x/y were given, and the answer always reports the measured state.
   *
   * Multi-step CDP has no database rollback: when a later step fails the actually applied fields
   * are committed first, then the error carries `phase/appliedFields/view` — never "no side effect".
   */
  async applyView(patch, { signal, source = 'agent', originId = null, expectedRevision = null } = {}) {
    if (expectedRevision !== null && expectedRevision !== undefined && expectedRevision !== this.view.revision) {
      throw new BrowserError('VIEWPORT_CONFLICT', '视口版本已变化（expectedRevision 与当前 revision 不同）', {
        expected: expectedRevision, actual: this.view.revision, view: this.viewProjection(),
      });
    }
    const before = this.viewProjection();
    const requested = { ...patch };
    const targetWidth = patch.width !== undefined ? patch.width : this.view.width;
    const targetHeight = patch.height !== undefined ? patch.height : this.view.height;
    const needsOverride = targetWidth !== this.view.width || targetHeight !== this.view.height;
    const wantsScroll = patch.x !== undefined || patch.y !== undefined;
    const appliedFields = [];
    let overrideApplied = false;
    try {
      await this.ensure(signal);
      if (needsOverride) {
        await this.send('Emulation.setDeviceMetricsOverride', {
          width: targetWidth, height: targetHeight, deviceScaleFactor: 1, mobile: false,
        }, signal);
        overrideApplied = true;
        if (patch.width !== undefined) appliedFields.push('width');
        if (patch.height !== undefined) appliedFields.push('height');
      }
      if (wantsScroll) {
        // The preserved axis uses the live scroll position, not the cached view value.
        const live = await this.#readViewMetrics(signal);
        const target = {
          x: patch.x !== undefined ? patch.x : live.x,
          y: patch.y !== undefined ? patch.y : live.y,
        };
        await this.#scrollViewTo(target.x, target.y, signal);
        if (patch.x !== undefined) appliedFields.push('x');
        if (patch.y !== undefined) appliedFields.push('y');
      }
      if (patch.scale !== undefined) appliedFields.push('scale');
      const { observed, settled } = await this.#settleViewObservation(signal);
      this.#commitViewObservation(observed, {
        source, originId, scale: patch.scale !== undefined ? patch.scale : null,
      });
      const view = this.viewProjection();
      return {
        ok: true,
        requested,
        before,
        view,
        observed: this.observedProjection(),
        viewMeta: this.viewMeta(),
        applied: true,
        settled,
        clamped: {
          x: requested.x !== undefined && Math.abs(observed.x - requested.x) > 0.01,
          y: requested.y !== undefined && Math.abs(observed.y - requested.y) > 0.01,
        },
        // Evidence only (additive): whether this set actually sent the emulation override.
        overrideApplied,
        appliedFields,
      };
    } catch (error) {
      const classified = asBrowserError(error);
      let last = null;
      if (!['ABORTED', 'CDP_DISCONNECTED'].includes(classified.code)) {
        last = await Promise.race([
          this.#readViewMetrics(undefined).catch(() => null),
          new Promise((resolve) => setTimeout(() => resolve(null), 500)),
        ]);
      }
      // Commit only what is provably applied, so the caller sees the real state, not the request.
      let changed = false;
      if (overrideApplied) {
        if (this.view.width !== targetWidth || this.view.height !== targetHeight) {
          this.view.width = targetWidth;
          this.view.height = targetHeight;
          changed = true;
        }
      }
      if (last) {
        this.observed = last;
        for (const key of ['x', 'y']) {
          if (Number.isFinite(last[key]) && Math.abs(last[key] - this.view[key]) > 1e-6) {
            this.view[key] = last[key];
            changed = true;
          }
        }
      }
      if (changed) {
        this.view.source = source;
        this.view.revision += 1;
      }
      classified.details = {
        ...(classified.details && typeof classified.details === 'object' ? classified.details : {}),
        phase: classified.details && classified.details.phase ? classified.details.phase : (overrideApplied ? 'afterOverride' : 'apply'),
        appliedFields,
        view: this.viewProjection(),
        observed: this.observedProjection(),
      };
      throw classified;
    }
  }

  /**
   * Legacy `POST /viewport {width,height}` (docs/viewport-control.md §4.2): Number/round/clamp to
   * 200–4096, keep x/y (the browser constrains them) and scale. It always returns the clamped
   * request so an old client sees exactly the historical answer.
   */
  async applyViewport(width, height, signal) {
    if (!Number.isFinite(width) || !Number.isFinite(height)) throw new BrowserError('INVALID_ARGUMENT', '视口尺寸必须是有限数字');
    const w = Math.max(VIEW_LIMITS.width[0], Math.min(VIEW_LIMITS.width[1], Math.round(width)));
    const h = Math.max(VIEW_LIMITS.height[0], Math.min(VIEW_LIMITS.height[1], Math.round(height)));
    if (w !== this.view.width || h !== this.view.height) {
      this.view.width = w;
      this.view.height = h;
      this.view.source = 'gui';
      this.view.revision += 1;
    }
    await this.send('Emulation.setDeviceMetricsOverride', {
      width: w,
      height: h,
      deviceScaleFactor: 1,
      mobile: false,
    }, signal);
    return { width: w, height: h };
  }

  touchHuman(ms = 4000) {
    this.humanUntil = Date.now() + ms;
    this.activity = '人类正在操作浏览器';
  }

  touchAgent(text) {
    this.agentUntil = Date.now() + AGENT_HOLD_MS;
    this.activity = text;
  }

  /**
   * Record the most recent failure.
   *
   * `lastError` used to be a bare string, so a caller could not tell a fresh failure from one
   * that happened before several successful operations, nor which action produced it. A failure
   * is now stamped with `lastErrorAt` (epoch ms), `lastErrorActionId` and a redacted
   * `lastErrorTarget`; `state()` exposes them as `error/errorAt/errorActionId/errorTarget`
   * (all null except `error` = "" when there is no error). Successful page/network operations
   * clear the projection; diagnostics and the independent HTTP tool never touch it.
   */
  setError(message, { actionId = null, target = null } = {}) {
    const text = message === undefined || message === null ? '' : String(message);
    this.lastError = text;
    this.lastErrorAt = text ? Date.now() : 0;
    this.lastErrorActionId = text ? (actionId === undefined ? null : actionId) : null;
    this.lastErrorTarget = text ? (target === undefined ? null : target) : null;
  }

  /** Clear the last failure and its action evidence. */
  clearError() {
    this.lastError = '';
    this.lastErrorAt = 0;
    this.lastErrorActionId = null;
    this.lastErrorTarget = null;
  }

  state() {
    return {
      mode: this.mode(),
      activity: redactText(this.activity),
      url: this.url ? redactUrl(this.url) : '',
      owner: { mode: 'single-owner-lease', sessionId: this.lease && (this.active || this.lease.expiresAt > Date.now()) ? this.lease.sessionId : null },
      // Opaque workspace scope: id + optional workspaceId, never an absolute path.
      scope: this.scope,
      title: this.title,
      viewport: this.viewport,
      // Safe view projection (no page text, no path): browser_state and the authenticated
      // `ui.view` serve the same data (docs/viewport-control.md §4.2).
      view: this.viewProjection(),
      seq: this.frames.seq,
      running: Boolean(this.cdp && !this.cdp.closed),
      error: redactText(this.lastError),
      // Timeliness/attribution companions for `error`; all null when there is no error.
      errorAt: Number.isFinite(this.lastErrorAt) && this.lastErrorAt > 0 ? this.lastErrorAt : null,
      errorActionId: this.lastError ? this.lastErrorActionId : null,
      errorTarget: this.lastError && this.lastErrorTarget ? redactText(this.lastErrorTarget) : null,
    };
  }

  /**
   * GUI-only projection for the debug view's address bar, refresh and back/forward buttons.
   *
   * This is deliberately NOT part of `state()`: `browser_state` returns the redacted projection
   * above, and the real address must never enter a tool value, the network log or metrics. Only
   * the authenticated same-origin HTTP surface serves this shape (see `projectedState` in apply()).
   * `revision` orders snapshots so a late response cannot move the address bar backwards.
   */
  uiState() {
    this.uiRevision += 1;
    const running = Boolean(this.cdp && !this.cdp.closed);
    return {
      ...this.state(),
      ui: {
        version: 1,
        runtimeId: this.runtimeId,
        revision: this.uiRevision,
        scope: this.scope,
        address: running ? this.url : '',
        history: { ...(running ? this.history : emptyHistory()) },
        // Shared viewport projection (docs/viewport-control.md §4.2): the same `view` the Agent
        // tool reads, plus the observation and its freshness. Additive only.
        view: this.viewProjection(),
        viewMeta: this.viewMeta(),
        observed: this.observedProjection(),
      },
    };
  }

  /** One HTTP-poll response in the historical shape plus frame metadata and epoch. */
  framePayload(since, state = this.state()) {
    const latest = this.frames.latest();
    if (!latest || latest.seq === since) return { seq: this.frames.seq, pending: true, state };
    return {
      seq: latest.seq,
      epoch: latest.epoch,
      transport: 'poll',
      image: latest.data,
      width: latest.width,
      height: latest.height,
      pageWidth: latest.pageWidth,
      pageHeight: latest.pageHeight,
      capturedAt: latest.capturedAt,
      receivedAt: latest.receivedAt,
      state,
    };
  }

  /** Host-side frame pipeline metrics; transport counters are flattened when mounted. */
  metrics() {
    const push = this.frameTransport && typeof this.frameTransport.metrics === 'function'
      ? this.frameTransport.metrics()
      : null;
    const host = { ...this.frames.metrics(), ackFailures: this.ackFailures, push, cleanupError: this.cleanupError || null };    if (push) {
      host.clients = push.clients;
      host.pushed = push.pushed;
      host.coalesced = push.coalesced;
      host.blocked = push.blocked;
      host.stale = push.stale;
      host.rejected = push.rejected;
      host.pushIntervalMs = push.pushIntervalMs;
      host.dropped = { coalesced: push.coalesced, blocked: push.blocked, stale: push.stale };
    }
    return {
      ok: true,
      now: Date.now(),
      host,
      client: this.clientMetrics || null,
    };
  }

  /** Store the latest client-measured preview metrics (display FPS, latency, drops). */
  recordClientMetrics(input) {
    const number = (value) => (Number.isFinite(Number(value)) ? Math.round(Number(value) * 100) / 100 : null);
    const text = (value, fallback) => (typeof value === 'string' && value.length <= 32 ? value : fallback);
    this.clientMetrics = {
      transport: text(input && input.transport, 'unknown'),
      displayFps: number(input && input.displayFps),
      endToEndMs: number(input && input.endToEndMs),
      transportMs: number(input && input.transportMs),
      droppedClient: number(input && input.droppedClient),
      received: number(input && input.received),
      displayed: number(input && input.displayed),
      seq: number(input && input.seq),
      epoch: number(input && input.epoch),
      measured: input && input.measured === true,
      measuredAt: number(input && input.measuredAt) || Date.now(),
    };
    return this.clientMetrics;
  }

  async navigate(url, signal) {
    const target = await validateTarget(url, { origins: [...this.origins], signal });
    await this.ensure(signal);
    this.navigationError = undefined;
    // A write navigation invalidates metadata reads that started before it.
    this.metadataGeneration += 1;
    let result;
    try {
      result = await this.send('Page.navigate', { url: target }, signal);
    } catch (error) {
      if (error && typeof error.details === 'object') error.details = { ...error.details, targetId: this.page?.targetId, scope: this.scope.id };
      throw error;
    }
    if (result.errorText || this.navigationError) {
      throw this.navigationError || new BrowserError('NAV_FAILED', result.errorText, { url: redactUrl(target) });
    }
    // The write path publishes fresh title *and* history: the response's ui.history drives the
    // panel's back/forward buttons, so waiting for the next poll would hand the client a stale
    // projection. Both reads are issued together so this costs no extra round trip, and earlier
    // (background) reads are already stale because the generation was bumped above.
    const titleRead = this.refreshTitle(signal);
    const historyRead = this.#refreshHistoryForWrite(signal);
    historyRead.catch(() => { /* observed below; avoid an unhandled rejection on early throw */ });
    await titleRead;
    if (this.url.startsWith('chrome-error://')) throw new BrowserError('NAV_FAILED', '页面进入错误页', { url: redactUrl(target) });
    // Page.navigate returns at commit, not at load completion. Fetch interception also checks
    // subsequent Document redirects and link/history navigations before dispatch.
    try { await validateTarget(this.url, { origins: [...this.origins], signal }); }
    catch (error) {
      await this.send('Page.navigate', { url: 'about:blank' }, signal);
      throw new BrowserError('NAV_FAILED', error.message, { url: redactUrl(target) });
    }
    await historyRead;
    this.clearError();
    return { url: redactUrl(this.url) };
  }

  /**
   * Arm a one-shot waiter for a main-frame navigation commit.
   *
   * It must be installed BEFORE the CDP command is sent: a fast navigation can commit before
   * `send()` resolves, and a late waiter would then wait for a second commit that never comes.
   * The command ACK is not a commit — only the frame event is.
   */
  #commitWaiter(accept, { signal, timeoutMs = COMMIT_TIMEOUT_MS } = {}) {
    const cdp = this.cdp;
    if (!cdp || cdp.closed) throw new BrowserError('CDP_DISCONNECTED', '浏览器未运行');
    let settled = false;
    let resolvePromise;
    let rejectPromise;
    const promise = new Promise((resolve, reject) => { resolvePromise = resolve; rejectPromise = reject; });
    // The caller observes the rejection; the ignored handler covers the dispose() path.
    promise.catch(() => {});
    let timer;
    let off = () => {};
    const cleanup = () => {
      clearTimeout(timer);
      off();
      signal?.removeEventListener('abort', onAbort);
    };
    const finish = (error) => {
      if (settled) return;
      settled = true;
      cleanup();
      if (error) rejectPromise(error); else resolvePromise();
    };
    function onAbort() { finish(new BrowserError('ABORTED', '操作已取消')); }
    off = cdp.on((message) => {
      try { if (accept(message)) finish(); } catch { /* a predicate error must not settle the wait */ }
    });
    timer = setTimeout(() => finish(new BrowserError(cdp.closed ? 'CDP_DISCONNECTED' : 'CDP_TIMEOUT',
      cdp.closed ? 'CDP 连接已关闭' : '等待页面提交超时')), timeoutMs);
    timer.unref?.();
    signal?.addEventListener('abort', onAbort, { once: true });
    if (signal?.aborted) onAbort();
    return { promise, dispose: () => finish(new BrowserError('ABORTED', '操作已取消')) };
  }

  /** Main-frame (and only main-frame) navigation commit events. */
  #isMainFrameNavigation(message) {
    if (message.method === 'Page.frameNavigated') return message.params.frame.parentId === undefined;
    if (message.method === 'Page.navigatedWithinDocument') return message.params.frameId === this.mainFrameId;
    return false;
  }

  /**
   * Reload the current document with Page.reload. The client never supplies a URL: reloading is
   * "reload whatever the browser is showing", so a stale local input can never reload another page.
   */
  async reload(signal) {
    const cdp = this.cdp;
    if (!cdp || cdp.closed) throw new BrowserError('TARGET_NOT_FOUND', '浏览器未运行');
    if (this.url && this.url !== 'about:blank') {
      // The current URL comes from the browser itself, but it is still checked before re-requesting.
      await validateTarget(this.url, { origins: [...this.origins], signal });
    }
    this.navigationError = undefined;
    this.metadataGeneration += 1;
    const waiter = this.#commitWaiter((message) => message.method === 'Page.frameNavigated' && message.params.frame.parentId === undefined, { signal });
    try {
      await this.send('Page.reload', { ignoreCache: false }, signal);
      await waiter.promise;
    } finally {
      waiter.dispose();
    }
    if (this.navigationError) throw this.navigationError;
    await this.refreshMetadata(signal);
    if (this.url.startsWith('chrome-error://')) throw new BrowserError('NAV_FAILED', '页面进入错误页', { url: redactUrl(this.url) });
    this.clearError();
    return { url: redactUrl(this.url) };
  }

  /**
   * Move through the browser's own navigation history. The client only names a direction; the
   * entry id is read from CDP inside the serial queue, so a stale client-side index can never
   * pick a different page. Out-of-range moves dispatch nothing.
   */
  async historyMove(direction, signal) {
    if (direction !== 'back' && direction !== 'forward') {
      throw new BrowserError('INVALID_ARGUMENT', `direction 只支持 back/forward，收到 ${JSON.stringify(direction)}`);
    }
    const cdp = this.cdp;
    if (!cdp || cdp.closed) throw new BrowserError('TARGET_NOT_FOUND', '浏览器未运行');
    const info = await this.send('Page.getNavigationHistory', {}, signal);
    const entries = Array.isArray(info?.entries) ? info.entries : [];
    const current = Number(info?.currentIndex);
    const target = current + (direction === 'back' ? -1 : 1);
    this.#applyHistory(info);
    if (!entries.length || !Number.isInteger(current) || target < 0 || target >= entries.length) {
      return { moved: false, direction };
    }
    const entry = entries[target];
    // The only non-HTTP(S) target that may be restored is the browser's own initial blank page.
    if (String(entry.url) !== 'about:blank') {
      await validateTarget(String(entry.url), { origins: [...this.origins], signal });
    }
    this.navigationError = undefined;
    this.metadataGeneration += 1;
    const waiter = this.#commitWaiter((message) => this.#isMainFrameNavigation(message), { signal });
    try {
      await this.send('Page.navigateToHistoryEntry', { entryId: entry.id }, signal);
      await waiter.promise;
    } finally {
      waiter.dispose();
    }
    if (this.navigationError) throw this.navigationError;
    await this.refreshMetadata(signal);
    if (this.url.startsWith('chrome-error://')) throw new BrowserError('NAV_FAILED', '页面进入错误页', { url: redactUrl(this.url) });
    this.clearError();
    return { moved: true, direction };
  }

  async input(events, signal) {
    if (!Array.isArray(events) || events.some((event) => !event || !['mouse', 'wheel', 'key', 'text'].includes(event.kind))) {
      throw new BrowserError('INVALID_ARGUMENT', '输入事件 kind 无效');
    }
    // Normalize/validate the whole batch first: a bad modifiers value must not start Chromium.
    const prepared = events.map((event) => prepareInputEvent(event));
    await this.ensure(signal);
    for (const event of prepared) {
      if (event.kind === 'mouse' || event.kind === 'wheel') {
        await this.send('Input.dispatchMouseEvent', event.params, signal);
      } else if (event.kind === 'key') {
        await this.send('Input.dispatchKeyEvent', event.params, signal);
      } else if (event.kind === 'text') {
        await this.send('Input.insertText', event.params, signal);
      }
    }
    // A wheel/click/drag can move the page (momentum/smooth scroll/snap): two coalesced settling
    // samples, 50ms and 250ms after the dispatch (docs/viewport-control.md §3.2).
    this.refreshViewObservationSoon({ delayMs: 50 });
    this.refreshViewObservationSoon({ delayMs: 250 });
    return events.length;
  }

  async evaluate(expression, awaitPromise = true, signal) {
    await this.ensure(signal);
    const result = await this.send('Runtime.evaluate', {
      expression,
      returnByValue: true,
      awaitPromise,
      userGesture: true,
    }, signal);
    if (result.exceptionDetails) {
      const d = result.exceptionDetails;
      return { ok: false, error: new BrowserError('EVAL_ERROR', d.exception?.description || String(d.exception?.value ?? d.text ?? 'evaluation failed'), {
        url: d.url ? redactUrl(d.url) : null, line: d.lineNumber ?? null, column: d.columnNumber ?? null,
      }).payload() };
    }
    // A page value of `undefined` has no JSON representation: omit the field instead of
    // returning `value: undefined`, which the host value snapshot rejects.
    const type = result.result ? result.result.type : 'undefined';
    return {
      ok: true,
      ...(type === 'undefined' ? {} : { value: result.result.value }),
      type,
    };
  }

  async screenshot(signal) {
    await this.ensure(signal);
    const capturedAt = Date.now();
    const shot = await this.send('Page.captureScreenshot', { format: 'png' }, signal);
    return { base64: shot.data, viewport: this.viewport, capturedAt };
  }

  /**
   * P0 capture: one `Page.captureScreenshot` with a document-CSS clip.
   *
   * Geometry (`Page.getLayoutMetrics`):
   *   cssLayoutViewport.pageX/pageY  = document CSS offset of the visible viewport (scroll)
   *   cssLayoutViewport.clientWidth/Height = viewport size in CSS px
   * A `region` is given in the same document CSS space, so a region outside the current scroll
   * position is still a legal clip (see `capture_beyond_viewport` in the tool layer).
   *
   * Scale: `deviceScaleFactor` stays 1 because `applyViewport()` pins
   * `Emulation.setDeviceMetricsOverride(deviceScaleFactor: 1)`. Combining dsf>1 with clip.scale>1
   * would scale twice (measured 400x400 for a 100x100 clip at dsf2 × scale2), so only `clip.scale`
   * is used and `effectiveScale = scale * 1`.
   *
   * The page DPR is read once as *evidence only*: it never changes the expected output size. When
   * the read fails the value is `null` (unknown, not guessed) and the expectation still uses the
   * plugin-controlled dsf=1 (`deviceScaleFactorSource: 'runtime-override'`).
   *
   * Exactly one capture is dispatched: no retry, no second encoding, no PNG parsing here.
   * ABORTED / CDP_TIMEOUT / CDP_DISCONNECTED and the other existing classifications pass through
   * unchanged; only a protocol error, empty data or a capture failure without a more fitting code
   * becomes CAPTURE_FAILED.
   */
  async capture({ scale = 1, region, scaleSource = 'explicit' } = {}, signal) {
    const capturedAt = Date.now();
    // The resolved density source travels with the capture so evidence can say whether the caller
    // asked for this scale or the shared view.scale supplied it (docs/viewport-control.md §6.2).
    const resolvedScaleSource = scaleSource === 'view' ? 'view' : 'explicit';
    const viewRevisionAtCapture = this.view.revision;
    await this.ensure(signal);
    const deviceScaleFactor = 1;
    const effectiveScale = scale * deviceScaleFactor;

    let layout;
    try {
      layout = await this.send('Page.getLayoutMetrics', {}, signal);
    } catch (error) {
      throw this.#captureError(error, 'getLayoutMetrics');
    }
    const layoutViewport = (layout && layout.cssLayoutViewport) || {};
    const visualViewport = (layout && layout.cssVisualViewport) || {};
    const pick = (fromLayout, fromVisual, fallback) => {
      if (Number.isFinite(fromLayout)) return fromLayout;
      if (Number.isFinite(fromVisual)) return fromVisual;
      return fallback;
    };
    const scroll = {
      x: pick(layoutViewport.pageX, visualViewport.pageX, 0),
      y: pick(layoutViewport.pageY, visualViewport.pageY, 0),
    };
    const viewport = {
      width: pick(layoutViewport.clientWidth, visualViewport.clientWidth, this.viewport.width),
      height: pick(layoutViewport.clientHeight, visualViewport.clientHeight, this.viewport.height),
    };

    let pageDevicePixelRatio = null;
    try {
      const evaluated = await this.send('Runtime.evaluate', {
        expression: 'window.devicePixelRatio', returnByValue: true,
      }, signal);
      const value = evaluated && evaluated.result ? evaluated.result.value : undefined;
      if (typeof value === 'number' && Number.isFinite(value) && value > 0) pageDevicePixelRatio = value;
    } catch (error) {
      if (error && error.code === 'ABORTED') throw error;
      pageDevicePixelRatio = null;
    }

    const rect = region
      ? { x: region.x, y: region.y, width: region.width, height: region.height }
      : { x: scroll.x, y: scroll.y, width: viewport.width, height: viewport.height };

    // Defense in depth: the tool layer checks this before the browser starts, but the effective
    // rectangle is only known here (the visible viewport comes from CDP).
    const expected = expectedPixelSize({
      width: rect.width, height: rect.height, scale, deviceScaleFactor,
    });
    if (!hasPositiveOutputSize(expected)) {
      throw new BrowserError('INVALID_ARGUMENT', '截图输出尺寸会舍入到 0 像素（请提高 scale 或 region 尺寸）', {
        reason: 'empty-output-dimensions', phase: 'effectiveClip',
        expected: { width: expected.width, height: expected.height },
        requested: { region: rect, scale },
      });
    }
    if (expected.width * expected.height > CAPTURE_LIMITS.maxOutputPixels) {
      throw new BrowserError('CAPTURE_TOO_LARGE', '截图期望像素超过上限', {
        expected: { width: expected.width, height: expected.height, pixels: expected.width * expected.height },
        max: CAPTURE_LIMITS.maxOutputPixels,
        requested: { region: rect, scale },
      });
    }

    let shot;
    try {
      shot = await this.send('Page.captureScreenshot', {
        format: 'png',
        fromSurface: true,
        captureBeyondViewport: true,
        optimizeForSpeed: false,
        clip: { x: rect.x, y: rect.y, width: rect.width, height: rect.height, scale: effectiveScale },
      }, signal);
    } catch (error) {
      throw this.#captureError(error, 'captureScreenshot');
    }
    if (!shot || typeof shot.data !== 'string' || shot.data.length === 0) {
      throw new BrowserError('CAPTURE_FAILED', '截图没有返回 PNG 数据', {
        phase: 'captureScreenshot', reason: 'empty-data',
      });
    }
    const pngBytes = Buffer.from(shot.data, 'base64');
    if (pngBytes.length === 0) {
      throw new BrowserError('CAPTURE_FAILED', '截图返回的 base64 数据无法解码', {
        phase: 'captureScreenshot', reason: 'empty-bytes',
      });
    }
    return {
      base64: shot.data,
      pngBytes,
      capture: {
        requestedScale: scale,
        scaleSource: resolvedScaleSource,
        viewRevision: viewRevisionAtCapture,
        effectiveScale,
        deviceScaleFactor,
        deviceScaleFactorSource: 'runtime-override',
        pageDevicePixelRatio,
        scroll,
        viewport,
        region: rect,
        capturedAt,
      },
    };
  }

  /**
   * Live layout facts for a T3 source/act re-check (docs/t3-vision.md §3.1, §6 step 1).
   *
   * Read-only: no viewport/scroll/DPR change, no retry, no second capture. `cssContentSize` is the
   * document CSS content box a `Source.live` region must stay inside; `visualViewportScale` is the
   * pinch-zoom factor (must be 1 for coordinate input).
   */
  async layoutMetrics(signal) {
    await this.ensure(signal);
    let layout;
    try {
      layout = await this.send('Page.getLayoutMetrics', {}, signal);
    } catch (error) {
      throw this.#captureError(error, 'getLayoutMetrics');
    }
    const layoutViewport = (layout && layout.cssLayoutViewport) || {};
    const visualViewport = (layout && layout.cssVisualViewport) || {};
    const content = (layout && layout.cssContentSize) || {};
    const pick = (primary, fallback, or) => (Number.isFinite(primary) ? primary : Number.isFinite(fallback) ? fallback : or);
    return {
      scroll: {
        x: pick(layoutViewport.pageX, visualViewport.pageX, 0),
        y: pick(layoutViewport.pageY, visualViewport.pageY, 0),
      },
      viewport: {
        width: pick(layoutViewport.clientWidth, visualViewport.clientWidth, this.viewport.width),
        height: pick(layoutViewport.clientHeight, visualViewport.clientHeight, this.viewport.height),
      },
      contentSize: {
        width: pick(content.width, undefined, Number.NaN),
        height: pick(content.height, undefined, Number.NaN),
      },
      visualViewportScale: Number.isFinite(visualViewport.scale) ? visualViewport.scale : null,
    };
  }

  /** Page generation of the current target (public wrapper for T3 evidence/act checks). */
  pageGeneration() { return this.#t2PageGeneration(); }

  /** Document epoch of the current target (bumped on every document replacement). */
  documentEpoch() { return this.t2.documentEpoch; }

  /** Remember a product's provenance and last-observed vision operation (capabilities projection). */
  noteVisionOperation(operation, verdict) {
    this.visionObservation = {
      observedAt: Date.now(),
      lastOperation: operation,
      lastVerdict: typeof verdict === 'string' ? verdict : null,
    };
  }

  /** Drop every stored image/pin of this scope (plugin unload / runtime retire only). */
  disposeVision() {
    try { this.visionProducts.clear(); } catch { /* ignore */ }
    try { this.visionProvenance.clear(); } catch { /* ignore */ }
    this.visionObservation = null;
  }

  /**
   * Map a capture-stage failure onto the error taxonomy without hiding an existing classification.
   * A cancelled/timed-out/disconnected/out-of-slots capture keeps its own code and retryable flag;
   * everything else becomes CAPTURE_FAILED with a bounded, redacted reason.
   */
  #captureError(error, phase) {
    const passThrough = [
      'ABORTED', 'CDP_TIMEOUT', 'CDP_DISCONNECTED', 'BUSY', 'RUNTIME_LIMIT', 'UNSUPPORTED',
      'SCOPE_INVALID', 'SCOPE_NOT_FOUND', 'SCOPE_UNAVAILABLE', 'SCOPE_FORBIDDEN',
      'CAPTURE_FAILED', 'CAPTURE_TOO_LARGE',
    ];
    if (error instanceof BrowserError && passThrough.includes(error.code)) return error;
    const raw = error && error.message ? String(error.message) : String(error);
    return new BrowserError('CAPTURE_FAILED', '截图失败（' + phase + '）', {
      phase,
      reason: redactText(raw).slice(0, 200),
    });
  }

  /**
   * Headless flag for capture evidence: `Browser.getVersion` is answered by the page session, the
   * product string cannot change without a new browser process, so the answer is cached per
   * Runtime. A failure is reported as `null` (unknown), never guessed.
   */
  async browserProduct(signal) {
    if (this.productInfo) return this.productInfo;
    try {
      const info = await this.send('Browser.getVersion', {}, signal);
      const product = info && typeof info.product === 'string' && info.product ? info.product : null;
      const userAgent = info && typeof info.userAgent === 'string' && info.userAgent ? info.userAgent : null;
      // `--headless=new` reports product "Chrome/<version>" with no marker, while the userAgent
      // still contains "HeadlessChrome". Both are checked (never guessed) and the signal that
      // decided the answer is reported so the evidence stays auditable.
      let headless = null;
      let headlessSource = null;
      if (product && /HeadlessChrome/i.test(product)) {
        headless = true;
        headlessSource = 'product';
      } else if (userAgent && /HeadlessChrome/i.test(userAgent)) {
        headless = true;
        headlessSource = 'userAgent';
      } else if (product) {
        headless = false;
        headlessSource = 'product';
      } else if (userAgent) {
        headless = false;
        headlessSource = 'userAgent';
      }
      const resolved = { product, userAgent, headless, headlessSource };
      this.productInfo = resolved;
      return resolved;
    } catch (error) {
      if (error && error.code === 'ABORTED') throw error;
      return { product: null, headless: null };
    }
  }

  async computedStyle(selector, properties, signal) {
    await this.ensure(signal);
    const doc = await this.send('DOM.getDocument', { depth: -1, pierce: true }, signal);
    let node;
    try { node = await this.send('DOM.querySelector', { nodeId: doc.root.nodeId, selector }, signal); }
    catch (error) {
      if (error.code !== 'INTERNAL') throw error;
      throw new BrowserError('INVALID_ARGUMENT', '无效选择器：' + selector);
    }
    if (!node.nodeId) return { ok: false, error: new BrowserError('TARGET_NOT_FOUND', '未找到元素：' + selector).payload() };
    const computed = await this.send('CSS.getComputedStyleForNode', { nodeId: node.nodeId }, signal);
    const map = {};
    for (const entry of computed.computedStyle) map[entry.name] = entry.value;
    if (!properties || !properties.length) return { ok: true, style: map };
    const picked = {};
    for (const name of properties) picked[name] = map[name];
    return { ok: true, style: picked };
  }

  /* -------------------------------------------------------------------------------------------
   * Web P0 network tool support (docs/network-p0.md §2/§7/§8). Every method is a thin wrapper over
   * the pure `network` module: the Runtime only resolves scope/page/lease concerns and the durable
   * evidence root.
   * ----------------------------------------------------------------------------------------- */

  netTouch(operation) {
    this.net.observed = { lastCallAt: Date.now(), lastOperation: operation };
  }

  /** GUI/tool mark for network↔action correlation (basis:"temporal", never causal). */
  netMark({ tool = null, actionId = null, stepId = null, kind = 'tool', text = null, url = undefined, title = undefined }) {
    if (!this.net || !this.net.running) return null;
    // State marks carry the (already redacted) page url/title so a screenshot/state marker is
    // self-describing (§5.3 / C15).
    return this.net.mark({
      kind, tool, actionId, stepId, text,
      url: url === undefined ? (this.url || null) : url,
      title: title === undefined ? (this.title || null) : title,
    });
  }

  netEvidenceArguments(operation) {
    return network.evidenceBlock(this.net, operation);
  }

  /** `browser_network_session` (§2.1). `start` is the only lazy-start action. */
  async netSession(args, exec, signal) {
    assertKnownKeys(args, ['action', 'name', 'config'], 'session');
    const action = args.action;
    if (!network.NET_SESSION_ACTIONS.includes(action)) {
      throw new BrowserError('NET_INVALID_ARGUMENT', 'session.action 不合法: ' + String(action), { allowed: [...network.NET_SESSION_ACTIONS] });
    }
    if (action !== 'start' && args.config !== undefined && args.config !== null) {
      throw new BrowserError('NET_INVALID_ARGUMENT', 'config 只在 start 生效', { field: 'config' });
    }
    if (args.name !== undefined && args.name !== null
      && (typeof args.name !== 'string' || Buffer.byteLength(args.name, 'utf8') > 64)) {
      throw new BrowserError('NET_INVALID_ARGUMENT', 'name 必须是 ≤64 字节的字符串', { field: 'name' });
    }
    this.netTouch('session.' + action);
    if (action === 'start') {
      // Bookkeeping only: `start` never takes the browser lease (another agent in the same scope
      // must be able to start/status/reset without BUSY). CDP arming happens on the next page
      // operation via `needsArm` (see ensure()).
      const result = this.net.start({ name: args.name || 'default', config: args.config || null });
      if (result.changed) {
        if (this.netCtl.responseModification === null) this.netCtl.responseModification = false;
        this.netCtl.needsArm = true;
        // Declaring a network session is an explicit ownership hand-over for this scope: only one
        // session can run per scope, so a previous agent's lease must not block the new owner with
        // BUSY (its page work is already serialized by the page queue).
        if (this.lease && this.lease.sessionId !== exec.meta.sessionId) this.lease = undefined;
      }
      const status = this.net.status();
      return {
        ok: true, changed: result.changed === true,
        session: status.session, sessions: status.sessions,
        limits: network.limitsView(), subscriptions: status.subscriptions,
        ...sessionAliases(status),
        evidence: network.evidenceBlock(this.net, 'session.start'),
      };
    }
    if (action === 'stop') {
      const finishStop = async () => {
        // Terminate held requests first (a frozen request would keep the page hanging) and restore
        // plain network conditions. Fetch stays enabled with the navigation guard (R1-8).
        await this.#netReleaseAllHeld();
        const had = this.netCtl.rules.length > 0 || this.netCtl.condition.offline
          || this.netCtl.condition.latencyMs > 0 || this.netCtl.condition.downloadKbps > 0
          || this.netCtl.condition.uploadKbps > 0;
        this.netCtl.clearRules();
        this.netCtl.resetConditions();
        if (had && this.cdp && !this.cdp.closed) {
          await this.#netApplyConditions(signal).catch(() => { });
          await this.#netSyncFetch(signal);
        }
        this.net.stop();
      };
      if (this.cdp && !this.cdp.closed) {
        // `agent:false`: stopping must never claim the browser lease (a second agent has to be able
        // to stop the session it started) — it only needs the serial page queue.
        await this.run(finishStop, { signal, sessionId: exec.meta.sessionId, agent: false, action: { actionId: exec.meta.actionId, target: null } });
      } else {
        this.netCtl.clearRules();
        this.netCtl.resetConditions();
        this.net.stop();
      }
      const status = this.net.status();
      return {
        ok: true, changed: false, session: status.session, sessions: status.sessions,
        limits: network.limitsView(), subscriptions: status.subscriptions,
        ...sessionAliases(status),
        evidence: network.evidenceBlock(this.net, 'session.stop'),
      };
    }
    if (action === 'reset') {
      // Terminate held requests and push the restored (unthrottled) conditions before clearing the
      // store; Fetch stays enabled with the navigation guard (R1-8).
      await this.#netReleaseAllHeld();
      this.netCtl.clearRules();
      this.netCtl.resetConditions();
      if (this.cdp && !this.cdp.closed) {
        await this.#netApplyConditions(signal).catch(() => { });
        await this.#netSyncFetch(signal);
      }
      const reset = this.net.reset();
      const status = this.net.status();
      return {
        ok: true, reset: true, subscriptionsClosed: reset.subscriptionsClosed,
        session: status.session, sessions: status.sessions, limits: network.limitsView(),
        ...sessionAliases(status),
        evidence: network.evidenceBlock(this.net, 'session.reset'),
      };
    }
    const status = this.net.status();
    return {
      ok: true, changed: false, session: status.session, sessions: status.sessions,
      limits: network.limitsView(), subscriptions: status.subscriptions,
      ...sessionAliases(status),
      evidence: network.evidenceBlock(this.net, 'session.status'),
    };
  }

  netEvents(args) {
    this.netTouch('events');
    return network.queryEvents(this.net, args);
  }

  /**
   * `detail` is read-only: it never starts CDP work. But the body capture for a request is kicked
   * off at `loadingFinished`, and a caller that reads immediately would see `unavailable` purely
   * because that background read has not settled yet. Waiting (bounded) for the capture that is
   * already in flight is not a re-read — nothing new is requested from the page.
   */
  async netDetail(args) {
    this.netTouch('detail');
    await this.#netAwaitPendingBodies(args);
    this.netChainIncomplete = false;
    await this.#netAwaitChain(args);
    const result = network.detailEvent(this.net, args);
    if (this.netChainIncomplete) {
      result.chainIncomplete = true;
      if (result.dependencies && typeof result.dependencies === 'object') result.dependencies.chainIncomplete = true;
      if (Array.isArray(result.redirects)) {
        for (const hop of result.redirects) if (hop) hop.chainIncomplete = true;
      }
    }
    return result;
  }

  /**
   * Bounded wait (≤500ms) for the redirect/dependency chain of the resolved request: a caller that
   * reads `include:['redirects'|'dependencies']` right after the page-side action can arrive before
   * the redirect/response events of that request are in the store. Nothing new is requested from
   * the page (no CDP call, no body re-read); when the deadline passes the current projection is
   * returned with `chainIncomplete:true` so the caller can tell "not yet observed" from "no chain".
   */
  async #netAwaitChain(args = {}) {
    const include = Array.isArray(args.include) ? args.include : [];
    const wantsChain = include.length === 0 || include.includes('redirects') || include.includes('dependencies') || include.includes('all');
    if (!wantsChain) return;
    const deadline = Date.now() + 500;
    const chainOf = (event) => this.net.events.filter((item) => item.requestId === event.requestId);
    while (Date.now() < deadline) {
      let event = null;
      try {
        event = network.resolveEvent(this.net, {
          seq: Number.isInteger(args.seq) ? args.seq : null,
          requestId: args.requestId === undefined ? null : args.requestId,
          targetId: args.targetId === undefined ? null : args.targetId,
        });
      } catch {
        return;
      }
      const chain = chainOf(event);
      const answered = chain.some((item) => ['response', 'finished', 'failed', 'redirect'].includes(item.phase));
      // For a redirect hop the location must be known too, otherwise the edge cannot be derived yet.
      const pendingRedirect = chain.some((item) => item.phase === 'redirect' && !(item.redirect && item.redirect.to));
      const last = chain[chain.length - 1];
      const settled = answered && !pendingRedirect && last && ['response', 'finished', 'failed', 'redirect'].includes(last.phase);
      if (settled) return;
      if (!this.net.running) return;
      await new Promise((resolve) => { const timer = setTimeout(resolve, 20); if (typeof timer.unref === 'function') timer.unref(); });
    }
    this.netChainIncomplete = true;
  }

  async #netAwaitPendingBodies(args = {}) {
    const wantsBody = args.include === undefined || args.include === null
      || (Array.isArray(args.include) && (args.include.includes('body') || args.include.includes('all')));
    if (!wantsBody) return;
    // Poll briefly: the capture is kicked off at `loadingFinished`, so a caller that reads the
    // detail immediately after a click can arrive before that CDP event even exists. Nothing is
    // re-requested here — we only wait for work that is already (or imminently) in flight.
    const deadline = Date.now() + 700;
    while (Date.now() < deadline) {
      let event = null;
      try {
        event = network.resolveEvent(this.net, {
          seq: Number.isInteger(args.seq) ? args.seq : null,
          requestId: args.requestId === undefined ? null : args.requestId,
          targetId: args.targetId === undefined ? null : args.targetId,
        });
      } catch {
        return;
      }
      const pending = this.netBodyPending && this.netBodyPending.size > 0;
      const state = this.net.bodyState(event);
      const anyCaptured = state.request.state !== 'unavailable' || state.response.state !== 'unavailable';
      if (anyCaptured && !pending) return;
      if (!pending && !anyCaptured) {
        // Nothing in flight: either the capture already finished (unavailable is final) or the
        // request has not reached loadingFinished yet. Only keep waiting while the chain is fresh.
        const terminal = this.net.events.find((item) => item.requestId === event.requestId
          && (item.phase === 'finished' || item.phase === 'failed'));
        if (terminal && Date.now() - terminal.ts.wallMs > 2000) return;
      }
      await new Promise((resolve) => { const timer = setTimeout(resolve, 20); if (typeof timer.unref === 'function') timer.unref(); });
      if (!this.net.running) return;
    }
  }

  netTrace(args) {
    this.netTouch('trace.' + String(args.action));
    return network.traceNetwork(this.net, args);
  }

  /** `browser_network_subscribe` (§2.7): owner-only, independent cursors, hard pin budget. */
  netSubscribe(args, ownerSessionId) {
    try {
      return this.#netSubscribeImpl(args, ownerSessionId);
    } catch (error) {
      // Guarantee the observable contract: a code-bearing BrowserError with a non-empty message
      // (R1-2 / §2.7). A bare internal error would surface as `{message:''}` to the caller.
      const classified = asBrowserError(error);
      if (!classified.message || classified.code === 'INTERNAL') {
        throw new BrowserError('NET_SUBSCRIPTION_NOT_FOUND', '订阅操作失败: ' + String(classified.message || 'unknown'), {
          reason: classified.code,
        });
      }
      throw classified;
    }
  }

  #netSubscribeImpl(args, ownerSessionId) {
    assertKnownKeys(args, ['action', 'sessionId', 'subscriptionId', 'cursor', 'afterSeq', 'limit', 'kinds', 'ackSeq'], 'subscribe');
    if (!ownerSessionId) throw new BrowserError('NET_SUBSCRIPTION_FORBIDDEN', '缺少调用方身份', {});
    if (['poll', 'ack', 'close'].includes(String(args && args.action))
      && (args.subscriptionId === undefined || args.subscriptionId === null || args.subscriptionId === '')) {
      throw new BrowserError('NET_INVALID_ARGUMENT', 'subscribe.' + String(args.action) + ' 需要 subscriptionId', {});
    }
    const action = args.action;
    if (!network.NET_SUBSCRIBE_ACTIONS.includes(action)) {
      throw new BrowserError('NET_INVALID_ARGUMENT', 'subscribe.action 不合法: ' + String(action), { allowed: [...network.NET_SUBSCRIBE_ACTIONS] });
    }
    if (args.sessionId !== undefined && args.sessionId !== null) {
      const current = this.net.session ? this.net.session.id : null;
      if (String(args.sessionId) !== String(current)) {
        throw new BrowserError('NET_SESSION_NOT_FOUND', '网络会话不存在或不属于本 scope', { sessionId: String(args.sessionId) });
      }
    }
    this.netTouch('subscribe.' + action);
    if (action === 'create') {
      const created = network.subscriptionCreate(this.net, {
        ownerSessionId, kinds: args.kinds === undefined ? null : args.kinds,
        afterSeq: Number.isInteger(args.afterSeq) ? args.afterSeq : null,
      });
      return { ok: true, ...created, sessionId: this.net.session ? this.net.session.id : null, evidence: network.evidenceBlock(this.net, 'subscribe.create') };
    }
    if (action === 'poll') {
      const polled = network.subscriptionPoll(this.net, {
        subscriptionId: args.subscriptionId, ownerSessionId, cursor: args.cursor === undefined ? null : args.cursor,
        afterSeq: Number.isInteger(args.afterSeq) ? args.afterSeq : null,
        limit: args.limit === undefined ? null : args.limit,
        kinds: args.kinds === undefined ? null : args.kinds,
      });
      return { ...polled, evidence: network.evidenceBlock(this.net, 'subscribe.poll') };
    }
    if (action === 'ack') {
      const acked = network.subscriptionAck(this.net, {
        subscriptionId: args.subscriptionId, ownerSessionId,
        ackSeq: Number.isInteger(args.ackSeq) ? args.ackSeq : null,
      });
      return { ...acked, evidence: network.evidenceBlock(this.net, 'subscribe.ack') };
    }
    if (action === 'close') {
      const closed = network.subscriptionClose(this.net, { subscriptionId: args.subscriptionId, ownerSessionId });
      return { ...closed, evidence: network.evidenceBlock(this.net, 'subscribe.close') };
    }
    const listed = network.subscriptionList(this.net, { ownerSessionId });
    return { ...listed, evidence: network.evidenceBlock(this.net, 'subscribe.list') };
  }

  /** Pushes the combined throttle/offline state to the page (§7.4 + R1-13). */
  async #netApplyConditions(signal) {
    const params = this.netCtl.conditions();
    if (!this.cdp || this.cdp.closed) {
      this.netCtl.applyFailures.push({ at: Date.now(), reason: 'cdp-unavailable', params });
      return { applied: false, reason: 'cdp-unavailable', params };
    }
    try {
      await this.cdp.send('Network.emulateNetworkConditions', params, { signal, timeoutMs: 5000 });
      return { applied: true, params };
    } catch (error) {
      const classified = asBrowserError(error);
      this.netCtl.applyFailures.push({ at: Date.now(), reason: classified.code, params });
      return { applied: false, reason: classified.code, params };
    }
  }

  /** `browser_network_control` (§2.5). Read-only actions never take the page lease. */
  async netControl(args, exec, signal) {
    assertKnownKeys(args, ['action', 'sessionId', 'throttle', 'offline', 'rule', 'ruleId', 'requestId', 'seq', 'then', 'replay', 'mock', 'confirm'], 'control');
    const action = args.action;
    if (!network.NET_CONTROL_ACTIONS.includes(action)) {
      throw new BrowserError('NET_INVALID_ARGUMENT', 'control.action 不合法: ' + String(action), { allowed: [...network.NET_CONTROL_ACTIONS] });
    }
    if (args.sessionId !== undefined && args.sessionId !== null) {
      const current = this.net.session ? this.net.session.id : null;
      if (String(args.sessionId) !== String(current)) {
        throw new BrowserError('NET_SESSION_NOT_FOUND', '网络会话不存在或不属于本 scope', { sessionId: String(args.sessionId) });
      }
    }
    if (this.net.state === 'snapshot') {
      throw new BrowserError('NET_CONTROL_UNAVAILABLE', '离线证据会话不可控制页面', { state: 'snapshot' });
    }
    this.netTouch('control.' + action);
    const readOnly = action === 'intercept-list';
    const execute = async () => {
      if (action === 'intercept-list') {
        return { ok: true, action, ...this.netCtl.snapshot(), evidence: network.evidenceBlock(this.net, 'control.' + action) };
      }
      await this.ensure(signal);
      if (action === 'throttle') {
        if (!args.throttle || typeof args.throttle !== 'object') throw new BrowserError('NET_INVALID_ARGUMENT', 'throttle 需要 throttle 参数');
        this.netCtl.setThrottle({
          latencyMs: Number.isFinite(args.throttle.latencyMs) ? args.throttle.latencyMs : 0,
          downloadKbps: Number.isFinite(args.throttle.downloadKbps) ? args.throttle.downloadKbps : 0,
          uploadKbps: Number.isFinite(args.throttle.uploadKbps) ? args.throttle.uploadKbps : 0,
        });
        const applied = await this.#netApplyConditions(signal);
        if (!applied.applied) throw new BrowserError('NET_CONTROL_UNAVAILABLE', '网络条件下发失败', { reason: applied.reason, params: applied.params });
        return { ok: true, action, params: applied.params, ...this.netCtl.snapshot(), evidence: network.evidenceBlock(this.net, 'control.throttle') };
      }
      if (action === 'offline') {
        if (typeof args.offline !== 'boolean') throw new BrowserError('NET_INVALID_ARGUMENT', 'offline 需要布尔参数');
        this.netCtl.setOffline(args.offline);
        const applied = await this.#netApplyConditions(signal);
        if (!applied.applied) throw new BrowserError('NET_CONTROL_UNAVAILABLE', '网络条件下发失败', { reason: applied.reason, params: applied.params });
        return { ok: true, action, params: applied.params, ...this.netCtl.snapshot(), evidence: network.evidenceBlock(this.net, 'control.offline') };
      }
      if (action === 'intercept-add') {
        const rule = this.netCtl.addRule(args.rule);
        const synced = await this.#netSyncFetch(signal);
        return { ok: true, action, rule, fetch: synced, ...this.netCtl.snapshot(), evidence: network.evidenceBlock(this.net, 'control.intercept-add') };
      }
      if (action === 'intercept-remove') {
        const rule = this.netCtl.removeRule(args.ruleId);
        await this.#netSyncFetch(signal);
        return { ok: true, action, rule, ...this.netCtl.snapshot(), evidence: network.evidenceBlock(this.net, 'control.intercept-remove') };
      }
      if (action === 'intercept-clear') {
        const cleared = this.netCtl.clearRules();
        await this.#netReleaseAllHeld();
        await this.#netSyncFetch(signal);
        return { ok: true, action, cleared, ...this.netCtl.snapshot(), evidence: network.evidenceBlock(this.net, 'control.intercept-clear') };
      }
      if (action === 'hold') {
        const held = this.netCtl.listHeld();
        if (!held.length && !args.requestId) {
          throw new BrowserError('NET_CONTROL_UNAVAILABLE', 'hold 需要已存在的 behavior.kind:"hold" 规则命中，或显式 requestId', {});
        }
        return { ok: true, action, held, ...this.netCtl.snapshot(), evidence: network.evidenceBlock(this.net, 'control.hold') };
      }
      if (action === 'resume') {
        const then = network.validateThen(args.then);
        const held = this.netCtl.listHeld();
        const targets = args.requestId ? held.filter((entry) => entry.requestId === String(args.requestId)) : held;
        if (targets.length === 0) throw new BrowserError('NET_CONTROL_UNAVAILABLE', '没有处于 hold 的请求', { requestId: args.requestId || null });
        for (const entry of targets) {
          this.netCtl.releaseHold(entry.requestId);
          this.#netContinueHeld(entry.requestId, then);
        }
        return { ok: true, action, resumed: targets.length, then, ...this.netCtl.snapshot(), evidence: network.evidenceBlock(this.net, 'control.resume') };
      }
      if (action === 'replay') {
        // Mark the replay so the traffic it produces is attributable (§5.5 / C40).
        this.netMark({ kind: 'replay', text: 'replay' });
        {
          const targetEvent = network.resolveEvent(this.net, { seq: args.seq, requestId: args.requestId });
          const replayUrl = String(targetEvent.url || '');
          this.net.replayWindow = {
            url: replayUrl,
            // The stored URL is already masked (`?key=***`), so the query part cannot be compared
            // literally against the live request: match on the path prefix instead (C40).
            prefix: replayUrl.includes('?') ? replayUrl.slice(0, replayUrl.indexOf('?')) : replayUrl,
            until: Date.now() + 8000,
            at: Date.now(),
            by: 'control.replay',
          };
        }
        const replay = args.replay && typeof args.replay === 'object' ? args.replay : {};
        const count = Number.isInteger(replay.count) ? replay.count : 1;
        if (count < 1 || count > network.NET_LIMITS.replayCount) {
          throw new BrowserError('NET_INVALID_ARGUMENT', `replay.count 必须在 1–${network.NET_LIMITS.replayCount}`, { field: 'replay.count' });
        }
        const via = replay.via === 'http' ? 'http' : 'page';
        const event = network.resolveEvent(this.net, { seq: Number.isInteger(args.seq) ? args.seq : null, requestId: args.requestId || null });
        const results = [];
        for (let index = 0; index < count; index += 1) {
          if (via === 'page') {
            const expression = `fetch(${JSON.stringify(event.url)}, {method: ${JSON.stringify(event.method || 'GET')}, credentials: 'include'}).then((response) => ({status: response.status})).catch((error) => ({error: String(error && error.message || error)}))`;
            const evaluated = await this.evaluate(expression, true, signal);
            results.push({
              via,
              status: evaluated && evaluated.ok && evaluated.value && Number.isInteger(evaluated.value.status) ? evaluated.value.status : null,
              error: evaluated && evaluated.ok === false ? 'eval-failed' : (evaluated && evaluated.value && evaluated.value.error ? String(evaluated.value.error) : null),
            });
          } else {
            const client = (exec && exec.httpClient) || null;
            if (!client) throw new BrowserError('NET_CONTROL_UNAVAILABLE', 'replay via http 需要 Host HTTP 客户端', { via: 'http' });
            // The Host client rejects hop-by-hop / browser-only headers (accept-encoding, host,
            // content-length, cookie…), so only forward the ones it accepts.
            const ALLOWED = new Set(['accept', 'content-type', 'x-net-probe', 'x-net-token', 'authorization',
              'if-none-match', 'if-modified-since', 'range', 'user-agent', 'x-request-id', 'traceparent']);
            const headerSource = this.net.readHeaders({ targetId: event.targetId, cdpSessionId: event.cdpSessionId, requestId: event.requestId, hopId: event.hopId, kind: 'request' }).headers;
            const headers = Object.fromEntries(Object.entries(headerSource).filter(([name]) => ALLOWED.has(name.toLowerCase())));
            const request = await client.request({
              url: event.url, method: ['GET', 'HEAD', 'POST', 'PUT', 'PATCH', 'DELETE', 'OPTIONS'].includes(String(event.method || 'GET').toUpperCase()) ? String(event.method || 'GET').toUpperCase() : 'GET',
              ...(Object.keys(headers).length ? { headers } : {}),
            }, { signal, meta: exec.meta });
            results.push({ via, status: request && request.status !== undefined ? request.status : null });
          }
        }
        this.net.mark({ kind: 'replay', tool: 'browser_network_control', actionId: exec.meta.actionId, fromSeq: event.seq, text: 'replay ' + via });
        return { ok: true, action, via, count: results.length, results, fromSeq: event.seq, evidence: network.evidenceBlock(this.net, 'control.replay') };
      }
      if (action === 'mock') {
        const mock = args.mock && typeof args.mock === 'object' ? args.mock : null;
        if (!mock) throw new BrowserError('NET_INVALID_ARGUMENT', 'mock 需要 mock 参数');
        const source = Number.isInteger(args.seq) || args.requestId
          ? network.resolveEvent(this.net, { seq: Number.isInteger(args.seq) ? args.seq : null, requestId: args.requestId || null })
          : null;
        if (!source) throw new BrowserError('NET_INVALID_ARGUMENT', 'mock 需要 seq 或 requestId 指明被 mock 的请求');
        const rule = this.netCtl.addRule({
          pattern: { urlPattern: source.url, method: source.method || null },
          behavior: {
            kind: 'fulfill',
            status: Number.isInteger(mock.status) ? mock.status : 200,
            headers: mock.headers && typeof mock.headers === 'object' ? mock.headers : null,
            body: typeof mock.body === 'string' ? mock.body : null,
            fromRequestId: mock.fromRequestId || null,
          },
        });
        await this.#netSyncFetch(signal);
        return { ok: true, action, rule, ...this.netCtl.snapshot(), evidence: network.evidenceBlock(this.net, 'control.mock') };
      }
      // reset
      await this.#netReleaseAllHeld();
      this.netCtl.clearRules();
      this.netCtl.resetConditions();
      const applied = await this.#netApplyConditions(signal);
      await this.#netSyncFetch(signal);
      return { ok: true, action, params: applied.params, ...this.netCtl.snapshot(), evidence: network.evidenceBlock(this.net, 'control.reset') };
    };
    if (readOnly) return execute();
    return this.run(execute, { signal, sessionId: exec.meta.sessionId, agent: true, action: { actionId: exec.meta.actionId, target: this.url ? redactUrl(this.url) : null } });
  }

  /** Durable evidence root for this scope (env wins, otherwise the workspace cwd). */
  #netEvidenceRoot(exec) {
    const resolved = captureRootFor(exec);
    if (resolved.root === null) {
      throw new BrowserError('NET_OUTPUT_ROOT_UNKNOWN', '没有可用的持久证据根：请设置 DSH_UI_TESTING_CAPTURE_DIR 或在有工作区 cwd 的会话内调用', {
        reason: 'root_unknown',
      });
    }
    return resolved;
  }

  #netScopeHash() {
    return createHash('sha256').update(String(this.scope.id || 'scope')).digest('hex').slice(0, 32);
  }

  /** `browser_network_evidence` (§2.6). Export is persistent-root only (R1-4). */
  async netEvidence(args, exec) {
    assertKnownKeys(args, ['sessionId', 'action', 'format', 'out', 'persist', 'includeBodies', 'file', 'data', 'query', 'link', 'deleteFiles'], 'evidence');
    const action = args.action;
    if (!network.NET_EVIDENCE_ACTIONS.includes(action)) {
      throw new BrowserError('NET_INVALID_ARGUMENT', 'evidence.action 不合法: ' + String(action), { allowed: [...network.NET_EVIDENCE_ACTIONS] });
    }
    if (args.sessionId !== undefined && args.sessionId !== null) {
      const current = this.net.session ? this.net.session.id : null;
      if (String(args.sessionId) !== String(current)) {
        throw new BrowserError('NET_SESSION_NOT_FOUND', '网络会话不存在或不属于本 scope', { sessionId: String(args.sessionId) });
      }
    }
    this.netTouch('evidence.' + action);
    const store = this.net;
    if (action === 'export') {
      const format = args.format === 'har' ? 'har' : args.format === 'auto' || args.format === undefined || args.format === null
        ? ((typeof args.out === 'string' && args.out.endsWith('.har')) ? 'har' : 'jsonl')
        : args.format;
      if (!['jsonl', 'har'].includes(format)) throw new BrowserError('NET_INVALID_ARGUMENT', 'format 不合法', { field: 'format' });
      const rootInfo = this.#netEvidenceRoot(exec);
      const sessionId = store.session ? store.session.id : 'none';
      const stamp = new Date(Date.now()).toISOString().replace(/[:.]/g, '-');
      const name = args.persist === true && typeof args.out !== 'string'
        ? 'output/network/' + this.#netScopeHash() + '/network-' + sessionId + '-' + stamp + '.' + (format === 'har' ? 'har' : 'jsonl')
        : args.out;
      const resolved = network.resolveEvidencePath({ root: rootInfo.root, out: name, defaultName: 'output/network/' + this.#netScopeHash() + '/network-' + sessionId + '-' + stamp + '.jsonl', extensions: ['.jsonl', '.har'] });
      if (!resolved.ok) throw new BrowserError(resolved.code, resolved.message, resolved.details);
      const bytes = format === 'har'
        ? Buffer.from(JSON.stringify(network.toHar(store, { includeBodies: args.includeBodies === true }), null, 2), 'utf8')
        : network.toJsonl(store, { includeBodies: args.includeBodies === true });
      const published = network.publishEvidence(resolved.dir, resolved.absolutePath, bytes);
      if (!published.ok) {
        throw new BrowserError(published.code === 'OUTPUT_EXISTS' ? 'NET_OUTPUT_WRITE_FAILED' : 'NET_OUTPUT_WRITE_FAILED', '证据写入失败', {
          reason: published.code, name: resolved.relativePath,
        });
      }
      const sha256 = createHash('sha256').update(bytes).digest('hex');
      const artifact = network.registerArtifact(store, {
        format, relativePath: resolved.relativePath, absolutePath: resolved.absolutePath,
        bytes: published.bytes, sha256, includeBodies: args.includeBodies === true,
        events: store.events.length, seqs: store.events.map((event) => event.seq).slice(0, 2000),
      });
      return {
        ok: true,
        action: 'export',
        evidenceId: artifact.evidenceId,
        file: {
          pathKind: 'persist', persistence: 'root', relativePath: resolved.relativePath,
          bytes: published.bytes, format, events: store.events.length,
          integrity: store.integrity(),
        },
        evidence: network.evidenceBlock(store, 'evidence.export'),
      };
    }
    if (action === 'import') {
      const hasFile = typeof args.file === 'string' && args.file.length > 0;
      const hasData = typeof args.data === 'string' && args.data.length > 0;
      if (hasFile === hasData) throw new BrowserError('NET_INVALID_ARGUMENT', 'import 需要 file 或 data（恰好一个）');
      let text;
      let source;
      if (hasData) {
        if (Buffer.byteLength(args.data, 'utf8') > network.NET_LIMITS.importDataBytes) {
          throw new BrowserError('NET_QUOTA_EXCEEDED', 'data 超过 8 MiB 上限', { max: network.NET_LIMITS.importDataBytes });
        }
        text = args.data;
        source = { kind: 'data', format: args.format || 'auto' };
      } else {
        const rootInfo = this.#netEvidenceRoot(exec);
        const resolved = network.resolveEvidencePath({ root: rootInfo.root, out: args.file, extensions: ['.jsonl', '.har'] });
        if (!resolved.ok) throw new BrowserError(resolved.code, resolved.message, resolved.details);
        try {
          text = readFileSync(resolved.absolutePath, 'utf8');
        } catch (error) {
          throw new BrowserError('NET_IMPORT_FAILED', '证据文件不可读', { reason: error && error.code ? String(error.code) : 'read-failed', file: resolved.relativePath });
        }
        source = { kind: 'file', format: args.format || 'auto', relativePath: resolved.relativePath };
      }
      const parsed = network.parseImportedEvidence(text, { format: args.format || 'auto' });
      const loaded = network.loadImported(store, parsed, { name: parsed.meta && parsed.meta.session ? parsed.meta.session.name : null, source });
      return {
        ok: true,
        action: 'import',
        session: store.status().session,
        imported: { ...loaded, format: parsed.format, source },
        evidence: network.evidenceBlock(store, 'evidence.import'),
      };
    }
    if (action === 'index') {
      return { ok: true, action, ...network.indexView(store), evidence: network.evidenceBlock(store, 'evidence.index') };
    }
    if (action === 'search') {
      const query = args.query && typeof args.query === 'object' ? args.query : {};
      const found = network.searchArtifacts(store, query);
      return { ...found, action, evidence: network.evidenceBlock(store, 'evidence.search') };
    }
    if (action === 'link') {
      const link = args.link && typeof args.link === 'object' ? args.link : null;
      if (!link) throw new BrowserError('NET_INVALID_ARGUMENT', 'link 需要 link 参数');
      const linked = store.link({ seq: Number.isInteger(link.seq) ? link.seq : null, requestId: link.requestId || null, stepId: link.stepId || null, evidenceId: link.evidenceId || null });
      return { ok: true, action, link: linked, evidence: network.evidenceBlock(store, 'evidence.link') };
    }
    if (action === 'integrity') {
      return { ok: true, action, ...store.integrity(), evidence: network.evidenceBlock(store, 'evidence.integrity') };
    }
    if (action === 'list') {
      return { ok: true, action, files: network.listArtifacts(store), evidence: network.evidenceBlock(store, 'evidence.list') };
    }
    // clear
    const cleared = network.clearArtifacts(store);
    const deleted = [];
    if (args.deleteFiles === true) {
      for (const file of cleared.files) {
        if (!file.absolutePath) continue;
        try { unlinkSync(file.absolutePath); deleted.push(file.relativePath); } catch { /* already gone */ }
      }
    }
    store.steps.clear();
    store.links.clear();
    return { ok: true, action, cleared: cleared.cleared, deletedFiles: deleted, evidence: network.evidenceBlock(store, 'evidence.clear') };
  }

  async traffic(limit) {
    const size = Math.max(1, Math.min(Number.isFinite(limit) ? Math.floor(limit) : 50, NETWORK_LIMIT));
    return { entries: this.network.slice(-size) };
  }

  /* -------------------------------------------------------------------------------------------
   * Web T2 (structured GUI): ref registry, actionability, structured evidence and the seven page
   * operations. Contract: docs/t2-structured-gui.md.
   *
   * Every T2 tool runs inside run() (serial page queue + single-owner lease), so a snapshot and the
   * actions that follow it can never interleave with another workspace's operation.
   * ----------------------------------------------------------------------------------------- */

  /** Page generation of this runtime's current target (null when cold). */
  #t2PageGeneration() {
    return this.page && Number.isInteger(this.page.generation) ? this.page.generation : null;
  }

  /**
   * Drop every ref and the current capture identity.
   *
   * Called on a main-frame document commit, on main-context loss and on close (contract §3.2) —
   * never on a same-document (pushState/hash) navigation, where the nodes are still the same objects.
   */
  #t2ClearRefs() {
    this.t2.refs.clear();
    this.t2.refByKey.clear();
    this.t2.capture = null;
  }

  /** A document commit / main-context loss: refs stop being valid and the epoch moves forward. */
  #t2BumpDocumentEpoch() {
    this.t2.documentEpoch += 1;
    this.#t2ClearRefs();
  }

  #t2ReleaseGroup(objectGroup) {
    const cdp = this.cdp;
    if (!cdp || cdp.closed) return;
    cdp.send('Runtime.releaseObjectGroup', { objectGroup }).catch(() => {});
  }

  /** Capture numbers are monotonic per Runtime ("s1", "s2", …) and never reset (contract §3.1). */
  #t2NextCaptureId() {
    if (this.t2.captureSeq >= Number.MAX_SAFE_INTEGER - 1) {
      throw new BrowserError('UNSUPPORTED', '快照编号已耗尽：请重启调试实例后再继续');
    }
    this.t2.captureSeq += 1;
    return 's' + this.t2.captureSeq;
  }

  /** Ref numbers are monotonic and never recycled, not even after a navigation (contract §3.2). */
  #t2NextRefNumber() {
    if (this.t2.nextRefSeq >= Number.MAX_SAFE_INTEGER - 1) {
      throw new BrowserError('UNSUPPORTED', 'ref 编号已耗尽：请重启调试实例后再继续');
    }
    this.t2.nextRefSeq += 1;
    return 'e' + this.t2.nextRefSeq;
  }

  /** LRU eviction; refs produced by the capture that is being published are protected. */
  #t2EvictRef(protect) {
    let oldest = null;
    for (const record of this.t2.refs.values()) {
      if (protect && protect.has(record.ref)) continue;
      if (!oldest || record.lastUsed < oldest.lastUsed) oldest = record;
    }
    if (!oldest) return false;
    this.t2.refs.delete(oldest.ref);
    this.t2.refByKey.delete(oldest.documentEpoch + ':' + oldest.backendNodeId);
    return true;
  }

  /**
   * Assign (or reuse) one ref for a node of the capture being built.
   *
   * Identity is `(documentEpoch, backendNodeId)`: the same node keeps the ref it was first minted
   * with, which is what makes two captures of an unchanged page produce the same tree and digest.
   * A different node always gets a larger number — a ref number is never handed to another node.
   */
  #t2AssignRef(backendNodeId, facts, capture, minted) {
    const key = this.t2.documentEpoch + ':' + backendNodeId;
    const existingRef = this.t2.refByKey.get(key);
    if (existingRef && this.t2.refs.has(existingRef) && !minted.has(existingRef)) {
      const record = this.t2.refs.get(existingRef);
      record.role = facts.role;
      record.name = facts.name;
      record.bbox = facts.bbox === undefined ? null : facts.bbox;
      record.lastUsed = this.t2.refUseSeq++;
      minted.set(record.ref, record);
      return record;
    }
    if (existingRef) {
      const record = this.t2.refs.get(existingRef);
      record.role = facts.role;
      record.name = facts.name;
      record.bbox = facts.bbox === undefined ? null : facts.bbox;
      record.lastUsed = this.t2.refUseSeq++;
      return record;
    }
    const record = {
      ref: this.#t2NextRefNumber(),
      backendNodeId,
      documentEpoch: this.t2.documentEpoch,
      pageGeneration: this.#t2PageGeneration(),
      frameId: capture.frameId,
      mintedSnapshotId: capture.snapshotId,
      mintedDigest: capture.digest,
      role: facts.role,
      name: facts.name,
      bbox: facts.bbox === undefined ? null : facts.bbox,
      lastUsed: this.t2.refUseSeq++,
    };
    minted.set(record.ref, record);
    return record;
  }

  /** Publish the refs minted by one successful capture, trimming to the 2000-entry LRU budget. */
  #t2PublishRefs(minted, capture) {
    const protect = new Set();
    for (const record of minted.values()) {
      record.mintedSnapshotId = record.mintedSnapshotId || capture.snapshotId;
      record.mintedDigest = record.mintedDigest || capture.digest;
      this.t2.refs.set(record.ref, record);
      this.t2.refByKey.set(record.documentEpoch + ':' + record.backendNodeId, record.ref);
      protect.add(record.ref);
    }
    while (this.t2.refs.size > T2_LIMITS.maxRefs && this.#t2EvictRef(protect)) { /* trim LRU */ }
  }

  #t2Draft(operation, source = 'document') {
    return {
      operation,
      source,
      targets: [],
      before: null,
      after: null,
      dispatch: { started: false, eventCount: 0, completed: false, eventSource: null },
      escalation: { tier: null, reason: null },
      incomplete: [],
      truncated: false,
      networkFrom: this.t2.networkSeq,
    };
  }

  /**
   * Provenance of one call (contract §5.1).
   *
   * A ref request cites the capture that *minted* that ref (never the newest one); a selector or
   * document request cites the most recent successful capture; a snapshot cites itself; and a form
   * batch cites its first target. An unknown/evicted ref has no provenance at all (nulls) instead of
   * borrowing the current capture's identity.
   */
  #t2Provenance(draft) {
    const capture = this.t2.capture;
    const base = {
      runtimeId: this.runtimeId,
      pageGeneration: this.#t2PageGeneration(),
      documentEpoch: this.t2.documentEpoch,
    };
    if (draft.source === 'snapshot') {
      return { ...base, snapshotId: capture ? capture.snapshotId : null, digest: capture ? capture.digest : null, source: 'snapshot' };
    }
    const first = draft.targets.length ? draft.targets[0] : null;
    if (first && first.provenance) {
      const kind = first.requested && first.requested.kind ? first.requested.kind : 'document';
      return { ...base, snapshotId: first.provenance.snapshotId, digest: first.provenance.digest, source: kind };
    }
    return { ...base, snapshotId: capture ? capture.snapshotId : null, digest: capture ? capture.digest : null, source: draft.source };
  }

  /**
   * Allocate a monotonic seq for one Network event and record it in the bounded evidence window.
   *
   * The window is what makes `evidence.networkDelta` verifiable: a request, its response and its
   * failure are separate sequenced events, so two events that share a wall-clock millisecond stay
   * ordered and buffer evictions are counted in `dropped` instead of vanishing.
   */
  #t2NetworkSeq(message) {
    const params = message && message.params ? message.params : {};
    this.t2.networkSeq += 1;
    const seq = this.t2.networkSeq;
    const requestId = params.requestId === undefined ? null : params.requestId;
    const wall = Number.isFinite(params.wallTime) ? Math.round(params.wallTime * 1000) : Date.now();
    let entry = null;
    if (message.method === 'Network.requestWillBeSent' && params.request) {
      entry = {
        seq, requestId, url: String(params.request.url || ''), method: params.request.method || null,
        type: params.type || null, status: null, failed: false, errorText: null, at: wall,
      };
    } else if (message.method === 'Network.responseReceived' && params.response) {
      const pending = this.requests.get(requestId);
      entry = {
        seq, requestId, url: String(params.response.url || ''),
        method: pending && pending.method ? pending.method : null, type: params.type || null,
        status: Number.isInteger(params.response.status) ? params.response.status : null,
        failed: false, errorText: null, at: wall,
      };
    } else if (message.method === 'Network.loadingFailed') {
      const known = this.requests.get(requestId);
      entry = {
        seq, requestId, url: known && known.url ? String(known.url) : '',
        method: known && known.method ? known.method : null,
        type: known ? known.type : null, status: null, failed: true,
        errorText: params.errorText ? String(params.errorText) : null, at: wall,
      };
    }
    if (!entry) return;
    this.t2.networkEntries.push(entry);
    while (this.t2.networkEntries.length > NETWORK_LIMIT) {
      const evicted = this.t2.networkEntries.shift();
      this.t2.networkEvicted.push(evicted.seq);
      if (this.t2.networkEvicted.length > NETWORK_LIMIT) this.t2.networkEvicted.shift();
    }
  }

  /** Network window for one action: monotonic Runtime seq, never a Date.now() boundary guess. */
  #t2NetworkDelta(fromSeq) {
    const from = Number.isFinite(fromSeq) ? fromSeq : 0;
    const window = this.t2.networkEntries.filter((entry) => entry.seq > from);
    const kept = window.slice(-T2_LIMITS.networkEntries);
    const evicted = this.t2.networkEvicted.filter((seq) => seq > from).length;
    return {
      from,
      to: this.t2.networkSeq,
      total: window.length,
      dropped: evicted + (window.length - kept.length),
      entries: kept.map((entry) => ({
        seq: entry.seq,
        requestId: entry.requestId === undefined ? null : entry.requestId,
        url: entry.url ? t2TruncateBytes(redactUrl(String(entry.url)), T2_LIMITS.urlBytes) : '',
        method: entry.method === undefined ? null : entry.method,
        type: entry.type === undefined ? null : entry.type,
        status: Number.isInteger(entry.status) ? entry.status : null,
        failed: entry.failed === true,
        errorText: entry.errorText ? t2TruncateBytes(redactText(String(entry.errorText)), T2_LIMITS.networkErrorBytes) : null,
        at: Number.isFinite(entry.at) ? Math.round(entry.at) : null,
      })),
    };
  }

  #t2BuildEvidence(draft) {
    const capture = this.t2.capture;
    const currentProvenance = { snapshotId: capture ? capture.snapshotId : null, digest: capture ? capture.digest : null };
    const targets = draft.targets.slice(0, T2_LIMITS.targetMax).map((target) => ({
      fieldIndex: Number.isInteger(target.fieldIndex) ? target.fieldIndex : null,
      requested: target.requested,
      resolved: target.resolved === undefined ? null : target.resolved,
      nodeBefore: target.nodeBefore === undefined ? null : target.nodeBefore,
      nodeAfter: target.nodeAfter === undefined ? null : target.nodeAfter,
      provenance: target.provenance === undefined ? currentProvenance : target.provenance,
    }));
    const evidence = {
      version: T2_LIMITS.protocolVersion,
      operation: draft.operation,
      provenance: this.#t2Provenance(draft),
      targets,
      before: draft.before,
      after: draft.after,
      dispatch: {
        started: draft.dispatch.started === true,
        eventCount: Number.isFinite(draft.dispatch.eventCount) ? draft.dispatch.eventCount : 0,
        completed: draft.dispatch.completed === true,
        eventSource: draft.dispatch.eventSource === undefined ? null : draft.dispatch.eventSource,
      },
      networkDelta: this.#t2NetworkDelta(draft.networkFrom),
      escalation: { tier: draft.escalation.tier, reason: draft.escalation.reason },
      incomplete: [...new Set(draft.incomplete)],
      truncated: draft.truncated === true,
    };
    if (draft.targets.length > T2_LIMITS.targetMax) {
      evidence.incomplete.push('targets-truncated');
      evidence.truncated = true;
    }
    if (Buffer.byteLength(JSON.stringify(evidence), 'utf8') > T2_LIMITS.evidenceBytes) {
      evidence.networkDelta.entries = [];
      evidence.networkDelta.dropped = evidence.networkDelta.total;
      evidence.truncated = true;
      evidence.incomplete.push('evidence-truncated-network');
    }
    if (Buffer.byteLength(JSON.stringify(evidence), 'utf8') > T2_LIMITS.evidenceBytes) {
      for (const target of evidence.targets) {
        for (const phase of ['nodeBefore', 'nodeAfter']) {
          if (target[phase]) {
            target[phase].text = '';
            target[phase].name = t2TruncateBytes(target[phase].name, 64);
          }
        }
      }
      evidence.incomplete.push('evidence-truncated-text');
    }
    return evidence;
  }

  /** Human-readable, input-free evidence digest for a thrown error message (contract §5.2). */
  #t2Summarize(evidence) {
    const provenance = evidence.provenance || {};
    const parts = [
      'action=' + (evidence.operation || ''),
      'snapshotId=' + (provenance.snapshotId === null || provenance.snapshotId === undefined ? 'null' : provenance.snapshotId),
      'digest=' + (provenance.digest === null || provenance.digest === undefined ? 'null' : provenance.digest),
      'dispatch=' + [evidence.dispatch && evidence.dispatch.started ? 'started' : 'idle',
        String(evidence.dispatch ? evidence.dispatch.eventCount : 0),
        evidence.dispatch && evidence.dispatch.completed ? 'completed' : 'incomplete'].join('/'),
      'incomplete=' + (evidence.incomplete && evidence.incomplete.length ? evidence.incomplete.join(',') : 'none'),
    ];
    return '证据：' + parts.join(' ');
  }

  /**
   * Attach evidence to a failure and rethrow.
   *
   * Every T2 failure is a thrown BrowserError with `details.evidence` (contract §2.1/§6); the four
   * page-failure codes additionally carry their reason and, for hidden/covered targets, the T3
   * escalation hint. Nothing here re-reads the page after a cancel/disconnect.
   */
  async #t2Fail(error, draft, signal) {
    const classified = asBrowserError(error);
    const terminal = ['ABORTED', 'CDP_TIMEOUT', 'CDP_DISCONNECTED'].includes(classified.code);
    if (!terminal && draft.before && !draft.after) {
      try { await this.#t2Observe(draft, 'after', signal); }
      catch { draft.incomplete.push('observation-after-failed'); }
    }
    const reason = classified.details && classified.details.reason ? String(classified.details.reason) : null;
    if (classified.code === 'NOT_INTERACTABLE' && reason) {
      if (reason === 'unstable') {
        draft.escalation = { tier: 'T4', reason: 'motion:unstable' };
        if (!classified.details.escalation) classified.details = { ...classified.details, escalation: 'T4' };
      } else {
        draft.escalation = { tier: 'T3', reason: `visual:${reason}` };
        if (reason === 'hidden' || reason === 'covered') classified.details = { ...classified.details, escalation: 'T3' };
      }
    }
    const evidence = this.#t2BuildEvidence(draft);
    if (!classified.details || typeof classified.details !== 'object' || Array.isArray(classified.details)) classified.details = {};
    classified.details = { ...classified.details, evidence };
    classified.message += ' ' + this.#t2Summarize(evidence);
    throw classified;
  }

  async #t2Call(objectId, functionDeclaration, argumentValues, signal, { awaitPromise = false } = {}) {
    const response = await this.send('Runtime.callFunctionOn', {
      objectId,
      functionDeclaration,
      arguments: (argumentValues || []).map((value) => ({ value })),
      returnByValue: true,
      awaitPromise,
    }, signal);
    if (response && response.exceptionDetails) {
      const detail = response.exceptionDetails;
      const description = detail.exception && detail.exception.description ? detail.exception.description : detail.text;
      throw new BrowserError('INTERNAL', '元素探测失败：' + t2TruncateBytes(t2Flatten(description), 200));
    }
    return response && response.result ? response.result.value : undefined;
  }

  #t2NodeInfo(objectId, signal, { scrollIntoView = false } = {}) {
    return this.#t2Call(objectId, T2_NODE_INFO_FN, [{ scrollIntoView, attributeLimit: T2_LIMITS.targetMax }], signal);
  }

  async #t2NodeInfoQuiet(objectId, signal) {
    try { return await this.#t2NodeInfo(objectId, signal, {}); }
    catch (error) {
      if (['ABORTED', 'CDP_TIMEOUT', 'CDP_DISCONNECTED'].includes(error && error.code)) throw error;
      return null;
    }
  }

  /** Page observation for evidence: address/title/scroll/viewport + the deep-shadow focus. */
  async #t2Observe(draft, phase, signal) {
    let observation = null;
    try {
      const state = await this.send('Runtime.evaluate', { expression: T2_PAGE_STATE_FN, returnByValue: true }, signal);
      const value = (state && state.result && state.result.value) || {};
      let focus = null;
      if (value.hasFocus === true) {
        try {
          const handle = await this.send('Runtime.evaluate', {
            expression: T2_DEEP_FOCUS_FN, returnByValue: false, objectGroup: 't2-observe',
          }, signal);
          const objectId = handle && handle.result ? handle.result.objectId : undefined;
          if (objectId) {
            const described = await this.send('DOM.describeNode', { objectId }, signal);
            const info = await this.#t2NodeInfo(objectId, signal, {});
            focus = {
              backendNodeId: described && described.node && Number.isInteger(described.node.backendNodeId) ? described.node.backendNodeId : null,
              role: info && info.ok === true ? t2TruncateBytes(String(info.role), T2_LIMITS.roleBytes) : null,
              name: info && info.ok === true ? t2Public(info.name, T2_LIMITS.nameBytes) : null,
            };
          } else {
            draft.incomplete.push('focus-unreadable');
          }
          this.#t2ReleaseGroup('t2-observe');
        } catch (error) {
          if (['ABORTED', 'CDP_TIMEOUT', 'CDP_DISCONNECTED'].includes(error && error.code)) throw error;
          draft.incomplete.push('focus-unreadable');
        }
      }
      observation = {
        observedAt: Date.now(),
        url: t2TruncateBytes(redactUrl(String(value.url || '')), T2_LIMITS.urlBytes),
        title: t2Public(value.title, T2_LIMITS.titleBytes),
        focus,
        scroll: {
          x: Number.isFinite(value.scrollX) ? value.scrollX : 0,
          y: Number.isFinite(value.scrollY) ? value.scrollY : 0,
        },
        viewport: {
          width: Number.isFinite(value.viewportWidth) ? value.viewportWidth : this.viewport.width,
          height: Number.isFinite(value.viewportHeight) ? value.viewportHeight : this.viewport.height,
        },
      };
    } catch (error) {
      if (['ABORTED', 'CDP_TIMEOUT', 'CDP_DISCONNECTED'].includes(error && error.code)) throw error;
      draft.incomplete.push(`observation-${phase}-failed`);
    }
    if (phase === 'before') draft.before = observation;
    else draft.after = observation;
    return observation;
  }

  /** Public NodeState projection. Editable values are never published (contract §5.2). */
  #t2NodeState(info) {
    if (!info || info.ok !== true) return null;
    const sensitive = info.sensitive === true;
    const editable = info.editable === true;
    const scroll = info.scroll || {};
    return {
      connected: info.connected === true,
      role: t2TruncateBytes(String(info.role === undefined || info.role === null ? '' : info.role), T2_LIMITS.roleBytes),
      name: t2Public(info.name, T2_LIMITS.nameBytes),
      tagName: String(info.tagName || ''),
      inputType: info.inputType === undefined ? null : info.inputType,
      visible: typeof info.visible === 'boolean' ? info.visible : null,
      enabled: typeof info.enabled === 'boolean' ? info.enabled : null,
      editable: typeof info.editable === 'boolean' ? info.editable : null,
      readOnly: typeof info.readOnly === 'boolean' ? info.readOnly : null,
      checked: info.checked === undefined ? null : info.checked,
      selected: info.selected === undefined ? null : info.selected,
      expanded: info.expanded === undefined ? null : info.expanded,
      required: typeof info.required === 'boolean' ? info.required : null,
      invalid: info.invalid === undefined ? null : info.invalid,
      focused: typeof info.focused === 'boolean' ? info.focused : null,
      bbox: info.bbox ? { x: info.bbox.x, y: info.bbox.y, width: info.bbox.width, height: info.bbox.height } : null,
      inViewport: typeof info.inViewport === 'boolean' ? info.inViewport : null,
      hitTarget: info.hitTarget === undefined || info.hitTarget === null ? null : info.hitTarget === true,
      text: sensitive ? '' : t2Public(info.text, T2_LIMITS.textBytes),
      value: null,
      valueRedacted: editable,
      scroll: {
        x: Number.isFinite(scroll.x) ? scroll.x : 0,
        y: Number.isFinite(scroll.y) ? scroll.y : 0,
        scrollWidth: Number.isFinite(scroll.scrollWidth) ? scroll.scrollWidth : 0,
        scrollHeight: Number.isFinite(scroll.scrollHeight) ? scroll.scrollHeight : 0,
        clientWidth: Number.isFinite(scroll.clientWidth) ? scroll.clientWidth : 0,
        clientHeight: Number.isFinite(scroll.clientHeight) ? scroll.clientHeight : 0,
      },
    };
  }

  #t2Resolved(target, verified) {
    const info = verified.info;
    return {
      ref: target.kind === 'ref' ? target.ref : null,
      role: t2TruncateBytes(String(info.role === undefined || info.role === null ? '' : info.role), T2_LIMITS.roleBytes),
      name: t2Public(info.name, T2_LIMITS.nameBytes),
      bbox: info.bbox ? { x: info.bbox.x, y: info.bbox.y, width: info.bbox.width, height: info.bbox.height } : null,
      frameId: this.mainFrameId ? String(this.mainFrameId) : 'MAIN',
      identity: {
        backendNodeId: verified.backendNodeId,
        objectResolved: true,
        connected: info.connected === true,
        ownerDocumentMatched: info.ownerDocumentMatched === true,
        backendNodeMatched: verified.backendNodeMatched === true,
      },
    };
  }

  /**
   * Evidence target shell.
   *
   * The entry exists *before* resolution so a failed target still reports what was requested, its
   * (empty) resolution and its provenance gap instead of producing an empty `targets` array
   * (contract §5.1). An unknown/evicted ref has no provenance instead of borrowing the current one.
   */
  #t2TargetShell(target, fieldIndex = null) {
    const record = target && target.kind === 'ref' ? this.t2.refs.get(target.ref) : null;
    const capture = this.t2.capture;
    let provenance;
    if (target && target.kind === 'ref') {
      provenance = record
        ? { snapshotId: record.mintedSnapshotId, digest: record.mintedDigest }
        : { snapshotId: null, digest: null };
    } else {
      provenance = { snapshotId: capture ? capture.snapshotId : null, digest: capture ? capture.digest : null };
    }
    return {
      fieldIndex,
      requested: t2Requested(target),
      resolved: null,
      nodeBefore: null,
      nodeAfter: null,
      provenance,
    };
  }

  /** Fill a shell once identity is proven (role/name/bbox/identity are current reads). */
  #t2FillTargetEntry(entry, target, verified) {
    entry.resolved = this.#t2Resolved(target, verified);
    entry.nodeBefore = this.#t2NodeState(verified.info);
    return entry;
  }

  #t2NotInteractable(reason, extra = {}) {
    return new BrowserError('NOT_INTERACTABLE', `目标不可交互：${reason}`, { reason, ...extra });
  }

  /**
   * Resolve one ref/selector target to an objectId + backendNodeId.
   *
   * A ref is validated against the Runtime registry (document epoch + identity), a selector against
   * the main document only — unique match, no first/nth, hidden duplicates included (contract §3.3).
   */
  async #t2ResolveTarget(target, signal) {
    if (target.kind === 'ref') {
      const entry = this.t2.refs.get(target.ref);
      if (!entry) throw new BrowserError('REF_STALE', 'ref 不在当前注册表中（未知或已被 LRU 淘汰）：请重新 browser_snapshot', { ref: target.ref });
      if (entry.documentEpoch !== this.t2.documentEpoch) {
        throw new BrowserError('REF_STALE', 'ref 属于已失效的文档代次：请重新 browser_snapshot', { ref: target.ref });
      }
      let resolved;
      try {
        resolved = await this.send('DOM.resolveNode', { backendNodeId: entry.backendNodeId, objectGroup: 't2-action' }, signal);
      } catch (error) {
        if (['ABORTED', 'CDP_TIMEOUT', 'CDP_DISCONNECTED'].includes(error && error.code)) throw error;
        throw new BrowserError('REF_STALE', 'ref 指向的节点已不存在：请重新 browser_snapshot', { ref: target.ref });
      }
      const objectId = resolved && resolved.object ? resolved.object.objectId : undefined;
      if (!objectId) throw new BrowserError('REF_STALE', 'ref 无法解析为页面节点：请重新 browser_snapshot', { ref: target.ref });
      return { objectId, backendNodeId: entry.backendNodeId, target };
    }
    const document = await this.send('DOM.getDocument', { depth: 0 }, signal);
    let matched;
    try {
      matched = await this.send('DOM.querySelectorAll', { nodeId: document.root.nodeId, selector: target.selector }, signal);
    } catch (error) {
      if (['ABORTED', 'CDP_TIMEOUT', 'CDP_DISCONNECTED'].includes(error && error.code)) throw error;
      throw t2InvalidArgument('selector 不是合法 CSS 选择器');
    }
    const nodeIds = matched && Array.isArray(matched.nodeIds) ? matched.nodeIds : [];
    if (nodeIds.length === 0) throw new BrowserError('TARGET_NOT_FOUND', 'selector 未命中元素', { count: 0 });
    if (nodeIds.length > 1) throw new BrowserError('TARGET_NOT_UNIQUE', 'selector 命中多个元素，T2 只接受唯一目标', { count: nodeIds.length });
    const described = await this.send('DOM.describeNode', { nodeId: nodeIds[0] }, signal);
    const backendNodeId = described && described.node && Number.isInteger(described.node.backendNodeId) ? described.node.backendNodeId : null;
    if (backendNodeId === null) throw new BrowserError('TARGET_NOT_FOUND', 'selector 命中的节点没有 backendNodeId');
    const resolved = await this.send('DOM.resolveNode', { backendNodeId, objectGroup: 't2-action' }, signal);
    const objectId = resolved && resolved.object ? resolved.object.objectId : undefined;
    if (!objectId) throw new BrowserError('TARGET_NOT_FOUND', 'selector 命中的节点无法解析为页面对象');
    return { objectId, backendNodeId, target };
  }

  /** Identity proof: Element, connected, same ownerDocument, same backendNodeId (contract §3.3). */
  async #t2VerifyIdentity(resolved, signal) {
    const info = await this.#t2NodeInfo(resolved.objectId, signal, {});
    if (!info || info.ok !== true) {
      const reason = info && info.reason ? info.reason : 'not-an-element';
      throw new BrowserError('REF_STALE', `目标节点不可用（${reason}）：请重新 browser_snapshot`, { reason });
    }
    if (info.connected !== true) throw new BrowserError('REF_STALE', '目标节点已脱离文档：请重新 browser_snapshot', { reason: 'detached' });
    if (info.ownerDocumentMatched !== true) throw new BrowserError('REF_STALE', '目标节点不属于当前文档：请重新 browser_snapshot', { reason: 'document-mismatch' });
    const described = await this.send('DOM.describeNode', { objectId: resolved.objectId }, signal);
    const backendNodeId = described && described.node && Number.isInteger(described.node.backendNodeId) ? described.node.backendNodeId : null;
    if (backendNodeId === null || backendNodeId !== resolved.backendNodeId) {
      throw new BrowserError('REF_STALE', '目标节点身份与 ref 记录不一致：请重新 browser_snapshot', { reason: 'identity-mismatch' });
    }
    return { info, backendNodeId, backendNodeMatched: true };
  }

  /** Actionability gate (contract §4.1): connected, visible, enabled, in viewport, uncovered. */
  #t2AssertActionable(info, { needEditable = false } = {}) {
    if (!info || info.ok !== true) throw new BrowserError('REF_STALE', '目标节点不可用：请重新 browser_snapshot', { reason: 'not-an-element' });
    if (info.connected !== true || info.ownerDocumentMatched !== true) {
      throw new BrowserError('REF_STALE', '目标节点已脱离文档：请重新 browser_snapshot', { reason: 'detached' });
    }
    // A CSS-hidden node is `hidden`; a laid-out node without area is `zero-area`. They are
    // different defects, so the reason must not collapse into one (contract §6 reason list).
    if (info.cssVisible !== true) throw this.#t2NotInteractable('hidden', { computed: info.computed });
    if (info.disabled === true) throw this.#t2NotInteractable(info.inert === true ? 'inert' : 'disabled', { disabledFieldset: info.disabledFieldset === true });
    if (info.hasBox !== true || !info.bbox || info.bbox.width <= 0 || info.bbox.height <= 0) {
      throw this.#t2NotInteractable('zero-area', { bbox: info.bbox });
    }
    if (!info.center) throw this.#t2NotInteractable('outside-viewport', { bbox: info.bbox });
    if (info.coveredBy) throw this.#t2NotInteractable('covered', { coveredBy: info.coveredBy });
    if (needEditable && info.readOnly === true) throw this.#t2NotInteractable('readonly');
    if (needEditable && info.editable !== true) throw this.#t2NotInteractable('not-editable', { tagName: info.tagName });
  }

  /** Two consecutive animation frames: a moving target is rejected, never retried with a stale bbox. */
  async #t2EnsureStable(objectId, signal) {
    const result = await this.#t2Call(objectId, T2_STABILITY_FN, [], signal, { awaitPromise: true });
    if (!result || result.ok !== true) throw this.#t2NotInteractable('detached');
    if (result.stable !== true) throw this.#t2NotInteractable('unstable', { delta: result.delta });
  }

  async #t2DispatchKey(params, signal, draft) {
    await this.send('Input.dispatchKeyEvent', params, signal);
    draft.dispatch.eventCount += 1;
  }

  /** Trusted mouse click at the freshly measured center of an already verified element. */
  async #t2MouseClick(info, { button = 'left', clickCount = 1, modifiers = [] } = {}, signal, draft) {
    const x = info.center.x;
    const y = info.center.y;
    const mask = T2_MOUSE_BUTTONS[button];
    let modifierMask = 0;
    for (const name of modifiers) modifierMask |= MODIFIER_BITS[name] || 0;
    await this.send('Input.dispatchMouseEvent', { type: 'mouseMoved', x, y, button: 'none', buttons: 0, modifiers: modifierMask }, signal);
    draft.dispatch.started = true;
    draft.dispatch.eventSource = 'cdp-input';
    for (let index = 1; index <= clickCount; index += 1) {
      await this.send('Input.dispatchMouseEvent', { type: 'mousePressed', x, y, button, buttons: mask, clickCount: index, modifiers: modifierMask }, signal);
      draft.dispatch.eventCount += 1;
      await this.send('Input.dispatchMouseEvent', { type: 'mouseReleased', x, y, button, buttons: mask, clickCount: index, modifiers: modifierMask }, signal);
      draft.dispatch.eventCount += 1;
    }
    draft.dispatch.completed = true;
    return { x, y };
  }

  async #t2DeepFocusBackendNodeId(signal) {
    const handle = await this.send('Runtime.evaluate', {
      expression: T2_DEEP_FOCUS_FN, returnByValue: false, objectGroup: 't2-action',
    }, signal);
    const objectId = handle && handle.result ? handle.result.objectId : undefined;
    if (!objectId) return null;
    const described = await this.send('DOM.describeNode', { objectId }, signal);
    return described && described.node && Number.isInteger(described.node.backendNodeId) ? described.node.backendNodeId : null;
  }

  async #t2PressCtrlA(signal, draft) {
    await this.#t2DispatchKey({ type: 'rawKeyDown', key: 'Control', code: 'ControlLeft', windowsVirtualKeyCode: 17, modifiers: 0 }, signal, draft);
    await this.#t2DispatchKey({ type: 'rawKeyDown', key: 'a', code: 'KeyA', windowsVirtualKeyCode: 65, modifiers: 2 }, signal, draft);
    await this.#t2DispatchKey({ type: 'keyUp', key: 'a', code: 'KeyA', windowsVirtualKeyCode: 65, modifiers: 2 }, signal, draft);
    await this.#t2DispatchKey({ type: 'keyUp', key: 'Control', code: 'ControlLeft', windowsVirtualKeyCode: 17, modifiers: 0 }, signal, draft);
  }

  async #t2PressBackspace(signal, draft) {
    await this.#t2DispatchKey({ type: 'rawKeyDown', key: 'Backspace', code: 'Backspace', windowsVirtualKeyCode: 8 }, signal, draft);
    await this.#t2DispatchKey({ type: 'keyUp', key: 'Backspace', code: 'Backspace', windowsVirtualKeyCode: 8 }, signal, draft);
  }

  async #t2PressEnter(signal, draft) {
    await this.#t2DispatchKey({ type: 'rawKeyDown', key: 'Enter', code: 'Enter', windowsVirtualKeyCode: 13, nativeVirtualKeyCode: 13 }, signal, draft);
    await this.#t2DispatchKey({ type: 'char', key: 'Enter', code: 'Enter', text: '\r', unmodifiedText: '\r', windowsVirtualKeyCode: 13, nativeVirtualKeyCode: 13 }, signal, draft);
    await this.#t2DispatchKey({ type: 'keyUp', key: 'Enter', code: 'Enter', windowsVirtualKeyCode: 13, nativeVirtualKeyCode: 13 }, signal, draft);
  }

  /** Type into an already-verified, focused control; the value is compared in memory only. */
  async #t2InsertText(resolved, info, text, { replace, currentValue }, signal, draft) {
    // Deleting a selection that does not exist would emit a needless `beforeinput`/delete event and
    // could consume a page-side one-shot listener; on an empty field the replace path is just the
    // insert (contract §4.1: replace clears, then inserts).
    if (replace && currentValue !== '') {
      await this.#t2PressCtrlA(signal, draft);
      await this.#t2PressBackspace(signal, draft);
    } else if (!replace) {
      const caret = await this.#t2Call(resolved.objectId, T2_CARET_END_FN, [], signal);
      if (!caret || caret.ok !== true) throw this.#t2NotInteractable('not-editable', { reason: caret && caret.reason });
    }
    // The focus can be stolen between the focusing click and this point (page handlers on
    // keydown/input); typing into whatever holds focus now would be a wrong-node write.
    const focusNow = await this.#t2DeepFocusBackendNodeId(signal);
    if (focusNow !== resolved.backendNodeId) throw this.#t2NotInteractable('focus-mismatch');
    if (text !== '') {
      await this.send('Input.insertText', { text }, signal);
      draft.dispatch.eventCount += 1;
    }
    draft.dispatch.started = true;
    draft.dispatch.eventSource = 'cdp-input';
    draft.dispatch.completed = true;
    const read = await this.#t2Call(resolved.objectId, T2_READ_VALUE_FN, [], signal);
    const actual = read && typeof read.value === 'string' ? read.value : null;
    const beforeValue = typeof info.value === 'string' ? info.value : '';
    const expected = replace ? text : beforeValue + text;
    return { expected, actual, matched: actual !== null && actual === expected };
  }

  /** Resolve every ref of a capture for `boxes:true` (bounded concurrency, viewport-relative). */
  async #t2FillBoxes(records, signal) {
    let cursor = 0;
    const worker = async () => {
      for (;;) {
        const index = cursor;
        cursor += 1;
        if (index >= records.length) return;
        const record = records[index];
        try {
          const resolved = await this.send('DOM.resolveNode', { backendNodeId: record.backendNodeId, objectGroup: 't2-box' }, signal);
          const objectId = resolved && resolved.object ? resolved.object.objectId : undefined;
          const info = objectId ? await this.#t2NodeInfo(objectId, signal, {}) : null;
          record.bbox = info && info.ok === true && info.bbox ? { ...info.bbox } : null;
        } catch (error) {
          if (['ABORTED', 'CDP_TIMEOUT', 'CDP_DISCONNECTED'].includes(error && error.code)) throw error;
          record.bbox = null;
        }
      }
    };
    const workers = [];
    for (let index = 0; index < Math.min(T2_LIMITS.boxConcurrency, records.length); index += 1) workers.push(worker());
    await Promise.all(workers);
    this.#t2ReleaseGroup('t2-box');
  }

  /* ---------------------------------------------------------------------------------------
   * browser_snapshot
   * ------------------------------------------------------------------------------------- */
  async snapshot(args, signal) {
    const draft = this.#t2Draft('browser_snapshot', 'snapshot');
    try {
      const options = t2Object(args || {}, 'args');
      t2RejectUnknown(options, ['scope', 'maxNodes', 'depth', 'boxes'], 'browser_snapshot');
      const maxNodes = t2IntegerField(options.maxNodes, T2_LIMITS.snapshotDefaultMaxNodes, 1, T2_LIMITS.snapshotMaxNodes, 'maxNodes');
      const depth = t2IntegerField(options.depth, T2_LIMITS.snapshotDefaultDepth, 0, T2_LIMITS.snapshotMaxDepth, 'depth');
      const boxes = t2BooleanField(options.boxes, false, 'boxes');
      let scope = null;
      if (options.scope !== undefined && options.scope !== null) {
        const scopeObject = t2Object(options.scope, 'scope');
        t2RejectUnknown(scopeObject, ['ref', 'selector'], 'scope');
        scope = t2RefOrSelector(scopeObject, { name: 'scope' });
      }
      draft.source = scope ? scope.kind : 'snapshot';
      await this.ensure(signal);
      await this.#t2Observe(draft, 'before', signal);
      const epoch = this.t2.documentEpoch;
      const generation = this.#t2PageGeneration();
      let scopeBackendNodeId = null;
      if (scope) {
        const scopeEntry = this.#t2TargetShell(scope);
        draft.targets.push(scopeEntry);
        const resolvedScope = await this.#t2ResolveTarget(scope, signal);
        const verified = await this.#t2VerifyIdentity(resolvedScope, signal);
        scopeBackendNodeId = verified.backendNodeId;
        this.#t2FillTargetEntry(scopeEntry, scope, verified);
      }
      const capture = { snapshotId: this.#t2NextCaptureId(), digest: null, frameId: this.mainFrameId ? String(this.mainFrameId) : 'MAIN' };
      const built = await this.#t2BuildTree({ capture, scopeBackendNodeId, maxNodes, depth, boxes, signal });
      if (this.t2.documentEpoch !== epoch || this.#t2PageGeneration() !== generation) {
        throw new BrowserError('REF_STALE', '快照采集期间页面代次已变化：整份快照被废弃，请重新 browser_snapshot', { reason: 'generation-changed' });
      }
      capture.digest = built.digest;
      this.t2.capture = capture;
      this.#t2PublishRefs(built.minted, capture);
      const refsJson = {};
      for (const [ref, record] of Object.entries(built.refs)) {
        refsJson[ref] = {
          role: record.role,
          name: record.name,
          backendNodeId: record.backendNodeId,
          frameId: record.frameId,
          bbox: record.bbox ? { x: record.bbox.x, y: record.bbox.y, width: record.bbox.width, height: record.bbox.height } : null,
          snapshotId: record.mintedSnapshotId,
          digest: record.mintedDigest,
        };
      }
      await this.#t2Observe(draft, 'after', signal);
      return {
        ok: true,
        snapshotId: capture.snapshotId,
        digest: built.digest,
        tree: built.tree,
        refs: refsJson,
        nodeCount: built.nodeCount,
        truncated: built.truncated,
        truncationReasons: built.truncationReasons,
        coverage: { frame: 'main', shadow: 'ax-backed', complete: !built.truncated },
        evidence: this.#t2BuildEvidence(draft),
      };
    } catch (error) {
      return this.#t2Fail(error, draft, signal);
    }
  }

  /**
   * backendNodeIds that live inside a *closed* shadow root.
   *
   * AX exposes closed-shadow content, but a ref must be a handle the page can actually be driven
   * through; a closed root cannot be hit-tested, focused or proven (contract §7), so those nodes get
   * a display line at most and never a ref.
   */
  async #t2ClosedShadowIds(signal) {
    const closed = new Set();
    let document;
    try {
      document = await this.send('DOM.getDocument', { depth: -1, pierce: true }, signal);
    } catch (error) {
      if (['ABORTED', 'CDP_TIMEOUT', 'CDP_DISCONNECTED'].includes(error && error.code)) throw error;
      return closed;
    }
    const walk = (node, inClosed) => {
      if (!node) return;
      if (inClosed && Number.isInteger(node.backendNodeId)) closed.add(node.backendNodeId);
      for (const child of Array.isArray(node.children) ? node.children : []) walk(child, inClosed);
      for (const root of Array.isArray(node.shadowRoots) ? node.shadowRoots : []) {
        walk(root, inClosed || root.shadowRootType === 'closed');
      }
      if (node.contentDocument && Array.isArray(node.contentDocument.children)) {
        for (const child of node.contentDocument.children) walk(child, inClosed);
      }
    };
    walk(document && document.root, false);
    return closed;
  }

  async #t2BuildTree({ capture, scopeBackendNodeId, maxNodes, depth, boxes, signal }) {
    await this.send('Accessibility.enable', {}, signal);
    const closedShadow = await this.#t2ClosedShadowIds(signal);
    const tree = await this.send('Accessibility.getFullAXTree', this.mainFrameId ? { frameId: this.mainFrameId } : {}, signal);
    const nodes = Array.isArray(tree && tree.nodes) ? tree.nodes : [];
    const byId = new Map();
    for (const node of nodes) if (node && node.nodeId) byId.set(node.nodeId, node);
    const childrenOf = new Map();
    const roots = [];
    for (const node of nodes) {
      if (!node || !node.nodeId) continue;
      const parentId = node.parentId;
      if (!parentId || !byId.has(parentId)) { roots.push(node); continue; }
      if (!childrenOf.has(parentId)) childrenOf.set(parentId, []);
      childrenOf.get(parentId).push(node);
    }
    const lines = [];
    const refs = {};
    const minted = new Map();
    const reasons = new Set();
    let nodeCount = 0;
    let treeBytes = 0;
    let resultBytes = 0;
    let stopped = false;
    const reserveBoxBytes = boxes ? 48 : 0;
    const emit = (level, formatted, backendNodeId) => {
      if (stopped) return false;
      if (nodeCount >= maxNodes) { reasons.add('maxNodes'); stopped = true; return false; }
      let record = null;
      const refEligible = formatted.isText !== true && formatted.refCandidate === true
        && Number.isInteger(backendNodeId) && !closedShadow.has(backendNodeId);
      if (refEligible) {
        record = this.#t2AssignRef(backendNodeId, { role: formatted.role, name: formatted.name, bbox: null }, capture, minted);
        record.lastUsed = this.t2.refUseSeq++;
      }
      const baseLine = '  '.repeat(level) + formatted.line + (record ? ' [ref=' + record.ref + ']' : '');
      const lineBytes = Buffer.byteLength(baseLine, 'utf8') + 1 + reserveBoxBytes;
      // Reserve a bounded estimate of the refs-map entry (role/name/backendNodeId/frameId/provenance).
      const refBytes = record ? Buffer.byteLength(JSON.stringify(record.ref), 'utf8') + 192 : 0;
      if (treeBytes + lineBytes > T2_LIMITS.treeBytes) { reasons.add('treeBytes'); stopped = true; return false; }
      if (resultBytes + lineBytes + refBytes > T2_LIMITS.resultBytes) { reasons.add('resultBytes'); stopped = true; return false; }
      treeBytes += lineBytes;
      resultBytes += lineBytes + refBytes;
      nodeCount += 1;
      lines.push({ level, baseLine, record });
      if (record) refs[record.ref] = record;
      return true;
    };
    const render = (node, level, parentRole = null) => {
      if (stopped) return;
      const children = childrenOf.get(node.nodeId) || [];
      if (node.ignored === true) {
        for (const child of children) { if (stopped) return; render(child, level, parentRole); }
        return;
      }
      if (level > depth) return;
      // Whitespace-only text leaves were folded into a neighbour: no line of their own.
      const projected = textProjection.has(node.nodeId) ? textProjection.get(node.nodeId) : undefined;
      if (projected === null) return;
      const formatted = t2FormatAxNode(node, { textOverride: projected });
      const backendNodeId = Number.isInteger(node.backendDOMNodeId) ? node.backendDOMNodeId : null;
      const isContainer = formatted.isText !== true && t2RoleIsContainer(formatted.role)
        && !formatted.name && (formatted.refCandidate !== true || backendNodeId === null);
      if (isContainer) {
        if (children.length === 0) return;                    // empty container: dropped
        if (children.length === 1) {                          // single child: collapsed
          render(children[0], level, formatted.role);
          return;
        }
        // An anonymous wrapper of the same role directly inside another one is pure nesting (no
        // name, no ref, no state): its children are hoisted instead of adding a duplicate line.
        if (parentRole !== null && parentRole === formatted.role) {
          for (const child of children) { if (stopped) return; render(child, level, formatted.role); }
          return;
        }
        if (!emit(level, formatted, backendNodeId)) return;   // multi-child container kept
        if (t2IsRedundantTextSubtree(node, children, childrenOf)) return;
        for (const child of children) { if (stopped) return; render(child, level + 1, formatted.role); }
        return;
      }
      if (!emit(level, formatted, backendNodeId)) return;
      // A text leaf is already the whole representation; its fragments are not emitted again.
      if (formatted.isText === true) return;
      // Redundant-representation merge (contract §3.1.1): the node already shows this exact text, so
      // its pure-text child chain is not emitted again. Merging happens before counting/byte budget
      // and never sets truncation — `nodeCount` stays the number of emitted lines.
      if (t2IsRedundantTextSubtree(node, children, childrenOf)) return;
      if (level + 1 <= depth) {
        for (const child of children) { if (stopped) return; render(child, level + 1, formatted.role); }
      } else if (children.length > 0) {
        // Real content was dropped by the depth limit: report it as a truncation, not as a
        // complete projection (contract §3.1.5).
        reasons.add('depth');
      }
    };
    let renderRoots;
    if (scopeBackendNodeId !== null) {
      const scoped = nodes.find((node) => node && node.backendDOMNodeId === scopeBackendNodeId);
      if (!scoped) throw new BrowserError('TARGET_NOT_FOUND', 'scope 节点不在无障碍树中');
      renderRoots = [scoped];
    } else {
      renderRoots = roots;
    }
    // Text projection is document-ordered and computed on the rendered subtree only, so a space
    // outside the scope can never leak into the scope's first text line.
    const textProjection = t2BuildTextProjection(renderRoots, childrenOf);
    for (const root of renderRoots) { if (stopped) break; render(root, 0); }
    const mintedRecords = [...minted.values()];
    if (boxes) await this.#t2FillBoxes(mintedRecords, signal);
    const treeText = lines.map((line) => {
      if (!line.record || !line.record.bbox) return line.baseLine;
      const box = line.record.bbox;
      return line.baseLine + ' [box=' + box.x.toFixed(2) + ',' + box.y.toFixed(2) + ',' + box.width.toFixed(2) + ',' + box.height.toFixed(2) + ']';
    }).join('\n');
    const digest = sha256Short(treeText, 16);
    return {
      tree: treeText,
      digest,
      refs,
      minted,
      nodeCount,
      truncated: reasons.size > 0,
      truncationReasons: [...reasons],
    };
  }

  /* ---------------------------------------------------------------------------------------
   * browser_click
   * ------------------------------------------------------------------------------------- */
  async click(args, signal) {
    const draft = this.#t2Draft('browser_click', 'document');
    try {
      const options = t2Object(args || {}, 'args');
      t2RejectUnknown(options, ['ref', 'selector', 'button', 'clickCount', 'modifiers'], 'browser_click');
      const target = t2RefOrSelector(options, { name: '' });
      draft.source = target.kind;
      const rawButton = options.button === undefined || options.button === null ? 'left' : options.button;
      if (typeof rawButton !== 'string' || !Object.hasOwn(T2_MOUSE_BUTTONS, rawButton)) {
        throw t2InvalidArgument('button 只支持 left/right/middle');
      }
      const clickCount = t2IntegerField(options.clickCount, 1, 1, 2, 'clickCount');
      const modifiers = t2ModifierList(options.modifiers);
      await this.ensure(signal);
      await this.#t2Observe(draft, 'before', signal);
      const entry = this.#t2TargetShell(target);
      draft.targets.push(entry);
      const resolvedTarget = await this.#t2ResolveTarget(target, signal);
      const verified = await this.#t2VerifyIdentity(resolvedTarget, signal);
      this.#t2FillTargetEntry(entry, target, verified);
      const scrolled = await this.#t2NodeInfo(resolvedTarget.objectId, signal, { scrollIntoView: true });
      if (!scrolled || scrolled.ok !== true) throw this.#t2NotInteractable('detached');
      await this.#t2EnsureStable(resolvedTarget.objectId, signal);
      const ready = await this.#t2NodeInfo(resolvedTarget.objectId, signal, {});
      this.#t2AssertActionable(ready, {});
      entry.resolved = this.#t2Resolved(target, { info: ready, backendNodeId: resolvedTarget.backendNodeId, backendNodeMatched: true });
      const point = await this.#t2MouseClick(ready, { button: rawButton, clickCount, modifiers }, signal, draft);
      const after = await this.#t2NodeInfoQuiet(resolvedTarget.objectId, signal);
      entry.nodeAfter = this.#t2NodeState(after);
      if (!entry.nodeAfter) draft.incomplete.push('node-after-document-changed');
      await this.#t2Observe(draft, 'after', signal);
      this.#t2ReleaseGroup('t2-action');
      return {
        ok: true,
        dispatched: true,
        button: rawButton,
        clickCount,
        point: { x: point.x, y: point.y },
        evidence: this.#t2BuildEvidence(draft),
      };
    } catch (error) {
      return this.#t2Fail(error, draft, signal);
    }
  }

  /* ---------------------------------------------------------------------------------------
   * browser_type
   * ------------------------------------------------------------------------------------- */
  async typeText(args, signal) {
    const draft = this.#t2Draft('browser_type', 'document');
    try {
      const options = t2Object(args || {}, 'args');
      t2RejectUnknown(options, ['ref', 'selector', 'text', 'replace', 'submit'], 'browser_type');
      const target = t2RefOrSelector(options, { name: '' });
      draft.source = target.kind;
      const text = t2StringField(options.text, { name: 'text', maxBytes: T2_LIMITS.formTextBytes, allowEmpty: true });
      const replace = t2BooleanField(options.replace, true, 'replace');
      const submit = t2BooleanField(options.submit, false, 'submit');
      await this.ensure(signal);
      await this.#t2Observe(draft, 'before', signal);
      const entry = this.#t2TargetShell(target);
      draft.targets.push(entry);
      const resolvedTarget = await this.#t2ResolveTarget(target, signal);
      const verified = await this.#t2VerifyIdentity(resolvedTarget, signal);
      const before = verified.info;
      entry.nodeBefore = this.#t2NodeState(before);
      const tagName = String(before.tagName || '');
      const inputType = before.inputType === null || before.inputType === undefined ? '' : String(before.inputType);
      if (tagName !== 'input' && tagName !== 'textarea') {
        throw new BrowserError('UNSUPPORTED', 'browser_type 只支持原生单行输入框与 textarea；contenteditable/富文本编辑器不属于本层能力', {
          support: ['input text/search/email/url/tel/password', 'textarea'],
        });
      }
      if (tagName === 'input' && !['text', 'search', 'email', 'url', 'tel', 'password'].includes(inputType)) {
        throw new BrowserError('UNSUPPORTED', 'browser_type 不支持该 input 类型；number/date/file/hidden 请改用其它能力', {
          support: ['input text/search/email/url/tel/password', 'textarea'],
          inputType,
        });
      }
      if (tagName === 'input' && /[\r\n]/.test(text)) throw t2InvalidArgument('单行 input 的 text 不能包含 CR/LF');
      const scrolled = await this.#t2NodeInfo(resolvedTarget.objectId, signal, { scrollIntoView: true });
      if (!scrolled || scrolled.ok !== true) throw this.#t2NotInteractable('detached');
      await this.#t2EnsureStable(resolvedTarget.objectId, signal);
      const ready = await this.#t2NodeInfo(resolvedTarget.objectId, signal, {});
      this.#t2AssertActionable(ready, { needEditable: true });
      entry.resolved = this.#t2Resolved(target, { info: ready, backendNodeId: resolvedTarget.backendNodeId, backendNodeMatched: true });
      await this.#t2MouseClick(ready, { button: 'left', clickCount: 1, modifiers: [] }, signal, draft);
      const focusNode = await this.#t2DeepFocusBackendNodeId(signal);
      if (focusNode !== resolvedTarget.backendNodeId) throw this.#t2NotInteractable('focus-mismatch');
      const inserted = await this.#t2InsertText(resolvedTarget, ready, text, {
        replace, currentValue: typeof ready.value === 'string' ? ready.value : '',
      }, signal, draft);
      const afterInfo = await this.#t2NodeInfoQuiet(resolvedTarget.objectId, signal);
      entry.nodeAfter = this.#t2NodeState(afterInfo);
      if (!entry.nodeAfter) draft.incomplete.push('node-after-document-changed');
      if (inserted.matched !== true) throw this.#t2NotInteractable('value-mismatch');
      if (submit) await this.#t2PressEnter(signal, draft);
      await this.#t2Observe(draft, 'after', signal);
      this.#t2ReleaseGroup('t2-action');
      return {
        ok: true,
        dispatched: true,
        insertedCharacters: Array.from(text).length,
        replaced: replace,
        submitted: submit,
        evidence: this.#t2BuildEvidence(draft),
      };
    } catch (error) {
      return this.#t2Fail(error, draft, signal);
    }
  }

  /* ---------------------------------------------------------------------------------------
   * browser_scroll
   * ------------------------------------------------------------------------------------- */
  async scroll(args, signal) {
    const draft = this.#t2Draft('browser_scroll', 'document');
    try {
      const options = t2Object(args || {}, 'args');
      t2RejectUnknown(options, ['ref', 'selector', 'direction', 'amount', 'to'], 'browser_scroll');
      const target = t2RefOrSelector(options, { exactlyOne: false, allowNone: true });
      draft.source = target ? target.kind : 'document';
      const hasDirection = options.direction !== undefined && options.direction !== null;
      const hasTo = options.to !== undefined && options.to !== null;
      if (hasDirection === hasTo) throw t2InvalidArgument('direction 与 to 必须恰给一个');
      let direction = null;
      let to = null;
      if (hasDirection) {
        direction = t2StringField(options.direction, { name: 'direction', maxBytes: 16 });
        if (!['up', 'down', 'left', 'right'].includes(direction)) throw t2InvalidArgument('direction 只支持 up/down/left/right');
      } else {
        to = t2StringField(options.to, { name: 'to', maxBytes: 16 });
        if (to !== 'top' && to !== 'bottom') throw t2InvalidArgument('to 只支持 top/bottom');
        if (options.amount !== undefined && options.amount !== null) throw t2InvalidArgument('to 滚动不接受 amount');
      }
      const amount = hasDirection ? t2IntegerField(options.amount, T2_LIMITS.scrollAmount, 1, T2_LIMITS.scrollMaxAmount, 'amount') : null;
      await this.ensure(signal);
      await this.#t2Observe(draft, 'before', signal);
      let objectId;
      let point = { x: Math.round(this.viewport.width / 2), y: Math.round(this.viewport.height / 2) };
      let entry = null;
      if (target) {
        entry = this.#t2TargetShell(target);
        draft.targets.push(entry);
        const resolvedTarget = await this.#t2ResolveTarget(target, signal);
        const verified = await this.#t2VerifyIdentity(resolvedTarget, signal);
        this.#t2FillTargetEntry(entry, target, verified);
        objectId = resolvedTarget.objectId;
        // Every rejection below happens BEFORE any dispatch: zero wheel/mouse event, and the page as
        // well as the element keep their scroll offsets (both are recorded in the evidence).
        const reject = async (reason, extra = {}) => {
          entry.nodeAfter = this.#t2NodeState(await this.#t2NodeInfoQuiet(objectId, signal));
          return this.#t2NotInteractable(reason, { hint: T2_SCROLL_VIEWPORT_HINT, ...extra });
        };
        const ready = await this.#t2NodeInfo(resolvedTarget.objectId, signal, {});
        if (!ready || ready.ok !== true || ready.connected !== true) throw await reject('detached');
        if (ready.cssVisible !== true) throw await reject('hidden', { computed: ready.computed });
        // Same stability proof as click/type: two consecutive animation frames, bbox delta <= 1px.
        const stability = await this.#t2Call(resolvedTarget.objectId, T2_STABILITY_FN, [], signal, { awaitPromise: true });
        if (!stability || stability.ok !== true) throw await reject('detached');
        if (stability.stable !== true) throw await reject('unstable', { delta: stability.delta });
        if (ready.inViewport !== true || !ready.center) throw await reject('outside-viewport', { bbox: ready.bbox });
        if (ready.hitTarget !== true) throw await reject('covered', { coveredBy: ready.coveredBy });
        point = { x: ready.center.x, y: ready.center.y };
        entry.nodeAfter = this.#t2NodeState(ready);
      } else {
        const handle = await this.send('Runtime.evaluate', {
          expression: T2_DOCUMENT_SCROLLER_FN, returnByValue: false, objectGroup: 't2-action',
        }, signal);
        objectId = handle && handle.result ? handle.result.objectId : undefined;
        if (!objectId) throw new BrowserError('INTERNAL', '无法取得文档滚动容器');
      }
      // No range in the requested axis is a *boundary*, not a failure: the wheel/scrollTo is still
      // dispatched and the call reports moved:false (contract §4.3).
      const before = await this.#t2Call(objectId, T2_SCROLL_READ_FN, [], signal);
      if (to !== null) {
        const applied = await this.#t2Call(objectId, T2_SCROLL_TO_FN, [{ to }], signal);
        if (!applied || applied.ok !== true) throw this.#t2NotInteractable('not-scrollable', { reason: applied && applied.reason });
        draft.dispatch.started = true;
        draft.dispatch.completed = true;
        draft.dispatch.eventCount += 1;
        draft.dispatch.eventSource = 'dom-scroll';
      } else {
        const deltaX = direction === 'left' ? -amount : direction === 'right' ? amount : 0;
        const deltaY = direction === 'up' ? -amount : direction === 'down' ? amount : 0;
        await this.send('Input.dispatchMouseEvent', { type: 'mouseWheel', x: point.x, y: point.y, deltaX, deltaY, modifiers: 0 }, signal);
        draft.dispatch.started = true;
        draft.dispatch.completed = true;
        draft.dispatch.eventCount += 1;
        draft.dispatch.eventSource = 'cdp-input';
      }
      const settled = await this.#t2SettleScroll(objectId, signal);
      const after = settled.value || await this.#t2Call(objectId, T2_SCROLL_READ_FN, [], signal);
      if (entry) entry.nodeAfter = this.#t2NodeState(await this.#t2NodeInfoQuiet(objectId, signal));
      await this.#t2Observe(draft, 'after', signal);
      this.#t2ReleaseGroup('t2-action');
      const scrollBefore = { x: Number.isFinite(before && before.x) ? before.x : 0, y: Number.isFinite(before && before.y) ? before.y : 0 };
      const scrollAfter = { x: Number.isFinite(after && after.x) ? after.x : 0, y: Number.isFinite(after && after.y) ? after.y : 0 };
      return {
        ok: true,
        dispatched: true,
        requested: { direction, amount, to },
        scrollBefore,
        scrollAfter,
        moved: scrollBefore.x !== scrollAfter.x || scrollBefore.y !== scrollAfter.y,
        evidence: this.#t2BuildEvidence(draft),
      };
    } catch (error) {
      return this.#t2Fail(error, draft, signal);
    }
  }

  /** Poll the scroll offsets until they stop changing (max 1000ms) and report the settled value. */
  async #t2SettleScroll(objectId, signal) {
    const deadline = Date.now() + T2_LIMITS.prepareMs;
    let previous = await this.#t2Call(objectId, T2_SCROLL_READ_FN, [], signal);
    let samples = 0;
    for (;;) {
      checkAbort(signal);
      await abortable(delay(50), signal);
      samples += 1;
      const current = await this.#t2Call(objectId, T2_SCROLL_READ_FN, [], signal);
      const same = current && previous
        && current.x === previous.x && current.y === previous.y
        && current.windowX === previous.windowX && current.windowY === previous.windowY;
      if (same) return { value: current, samples, settled: true };
      previous = current;
      if (Date.now() >= deadline) return { value: current, samples, settled: false };
    }
  }

  /* ---------------------------------------------------------------------------------------
   * browser_fill_form
   * ------------------------------------------------------------------------------------- */
  async fillForm(args, signal) {
    const draft = this.#t2Draft('browser_fill_form', 'document');
    const results = [];
    let failedIndex = null;
    try {
      const options = t2Object(args || {}, 'args');
      t2RejectUnknown(options, ['fields'], 'browser_fill_form');
      if (!Array.isArray(options.fields) || options.fields.length === 0) throw t2InvalidArgument('fields 必须是非空数组');
      if (options.fields.length > T2_LIMITS.formFields) throw t2InvalidArgument(`fields 最多 ${T2_LIMITS.formFields} 项`);
      const fields = [];
      let totalText = 0;
      for (let index = 0; index < options.fields.length; index += 1) {
        const raw = t2Object(options.fields[index], `fields[${index}]`);
        t2RejectUnknown(raw, ['ref', 'selector', 'type', 'value'], `fields[${index}]`);
        const target = t2RefOrSelector(raw, { name: `fields[${index}].` });
        const type = t2StringField(raw.type, { name: `fields[${index}].type`, maxBytes: 32 });
        if (!T2_FORM_KINDS.includes(type)) throw t2InvalidArgument(`fields[${index}].type 只支持 ${T2_FORM_KINDS.join('/')}`);
        let value;
        let valueIsArray = false;
        if (type === 'textbox') {
          value = t2StringField(raw.value, { name: `fields[${index}].value`, maxBytes: T2_LIMITS.formTextBytes, allowEmpty: true });
          totalText += Buffer.byteLength(value, 'utf8');
        } else if (type === 'checkbox') {
          value = t2BooleanField(raw.value, undefined, `fields[${index}].value`);
        } else if (type === 'radio') {
          value = t2BooleanField(raw.value, undefined, `fields[${index}].value`);
          if (value !== true) throw t2InvalidArgument(`fields[${index}] 是 radio，value 只接受 true`);
        } else if (type === 'combobox') {
          if (typeof raw.value === 'string') {
            value = [t2StringField(raw.value, { name: `fields[${index}].value`, maxBytes: T2_LIMITS.comboOptionBytes, allowEmpty: true })];
            valueIsArray = false;
          } else if (Array.isArray(raw.value)) {
            if (!raw.value.length || raw.value.length > T2_LIMITS.comboValues) throw t2InvalidArgument(`fields[${index}].value 数组必须是 1–${T2_LIMITS.comboValues} 项`);
            value = raw.value.map((item, position) => t2StringField(item, { name: `fields[${index}].value[${position}]`, maxBytes: T2_LIMITS.comboOptionBytes, allowEmpty: true }));
            if (new Set(value).size !== value.length) throw t2InvalidArgument(`fields[${index}].value 数组不能有重复项`);
            valueIsArray = true;
          } else throw t2InvalidArgument(`fields[${index}].value 必须是字符串或字符串数组`);
        } else {
          value = t2NumberField(raw.value, undefined, -Number.MAX_SAFE_INTEGER, Number.MAX_SAFE_INTEGER, `fields[${index}].value`);
        }
        fields.push({ index, target, type, value, valueIsArray });
      }
      if (totalText > T2_LIMITS.formTextBytes) throw t2InvalidArgument(`整批文本值超过 ${T2_LIMITS.formTextBytes} UTF-8 字节`);
      await this.ensure(signal);
      await this.#t2Observe(draft, 'before', signal);
      // Whole-batch pre-check: identity, control type, option/range validity, duplicate targets.
      const prepared = [];
      const seen = new Set();
      for (const field of fields) {
        failedIndex = field.index;
        const entry = this.#t2TargetShell(field.target, field.index);
        draft.targets.push(entry);
        const resolvedTarget = await this.#t2ResolveTarget(field.target, signal);
        const verified = await this.#t2VerifyIdentity(resolvedTarget, signal);
        const info = verified.info;
        this.#t2FillTargetEntry(entry, field.target, verified);
        if (seen.has(verified.backendNodeId)) throw t2InvalidArgument(`fields[${field.index}] 与其他字段指向同一个节点`);
        seen.add(verified.backendNodeId);
        const tagName = String(info.tagName || '');
        const inputType = info.inputType === null || info.inputType === undefined ? '' : String(info.inputType);
        const textLike = tagName === 'textarea' || (tagName === 'input' && ['text', 'search', 'email', 'url', 'tel', 'password'].includes(inputType));
        if (field.type === 'textbox' && !textLike) throw this.#t2NotInteractable('type-mismatch', { fieldIndex: field.index, tagName, inputType });
        if (field.type === 'checkbox' && !(tagName === 'input' && inputType === 'checkbox')) throw this.#t2NotInteractable('type-mismatch', { fieldIndex: field.index, tagName, inputType });
        if (field.type === 'radio' && !(tagName === 'input' && inputType === 'radio')) throw this.#t2NotInteractable('type-mismatch', { fieldIndex: field.index, tagName, inputType });
        if (field.type === 'combobox') {
          if (tagName !== 'select') throw this.#t2NotInteractable('type-mismatch', { fieldIndex: field.index, tagName, inputType });
          // Option inventory is read (never written) during the pre-check, so a bad option can never
          // clobber the current selection: the whole batch fails before any input is dispatched.
          const inventory = await this.#t2Call(resolvedTarget.objectId, T2_SELECT_OPTIONS_FN, [], signal);
          if (!inventory || inventory.ok !== true) throw this.#t2NotInteractable('type-mismatch', { fieldIndex: field.index });
          if (inventory.multiple !== field.valueIsArray) {
            throw t2InvalidArgument(`fields[${field.index}] 的 value 形态与 select 单选/多选不匹配`);
          }
          const available = new Set(inventory.options.filter((option) => option.disabled !== true).map((option) => option.value));
          const known = new Set(inventory.options.map((option) => option.value));
          const missingOptions = field.value.filter((value) => !known.has(value));
          if (missingOptions.length) throw this.#t2NotInteractable('type-mismatch', { fieldIndex: field.index, missingCount: missingOptions.length });
          const disabledOptions = field.value.filter((value) => known.has(value) && !available.has(value));
          if (disabledOptions.length) throw this.#t2NotInteractable('disabled', { fieldIndex: field.index, unavailableCount: disabledOptions.length });
        }
        if (field.type === 'slider') {
          const range = await this.#t2Call(resolvedTarget.objectId, T2_RANGE_INFO_FN, [], signal);
          if (!range || range.ok !== true) throw this.#t2NotInteractable('type-mismatch', { fieldIndex: field.index, tagName, inputType });
          if (range.step === null) throw t2InvalidArgument(`fields[${field.index}] 的 slider step=any，无法有界表示`);
          if (field.value < range.min || field.value > range.max) throw t2InvalidArgument(`fields[${field.index}].value 超出 slider 的 min/max（${range.min}–${range.max}）`);
          if (range.step > 0) {
            const offset = (field.value - range.min) / range.step;
            if (Math.abs(offset - Math.round(offset)) > 1e-9) throw t2InvalidArgument(`fields[${field.index}].value 不符合 slider 的 step=${range.step}`);
          }
        }
        prepared.push({ field, resolvedTarget, entry, info });
      }
      // Execute in order; stop at the first failure, no rollback, no retry.
      for (const item of prepared) {
        checkAbort(signal);
        const { field, resolvedTarget, entry } = item;
        failedIndex = field.index;
        const fresh = await this.#t2NodeInfo(resolvedTarget.objectId, signal, { scrollIntoView: true });
        if (!fresh || fresh.ok !== true) throw new BrowserError('REF_STALE', '目标节点在填写过程中失效：请重新 browser_snapshot', { reason: 'detached', fieldIndex: field.index });
        await this.#t2EnsureStable(resolvedTarget.objectId, signal);
        const ready = await this.#t2NodeInfo(resolvedTarget.objectId, signal, {});
        this.#t2AssertActionable(ready, { needEditable: field.type === 'textbox' });
        entry.resolved = this.#t2Resolved(field.target, { info: ready, backendNodeId: resolvedTarget.backendNodeId, backendNodeMatched: true });
        if (field.type === 'textbox') {
          await this.#t2MouseClick(ready, { button: 'left', clickCount: 1, modifiers: [] }, signal, draft);
          const focusNode = await this.#t2DeepFocusBackendNodeId(signal);
          if (focusNode !== resolvedTarget.backendNodeId) throw this.#t2NotInteractable('focus-mismatch', { fieldIndex: field.index });
          const inserted = await this.#t2InsertText(resolvedTarget, ready, field.value, {
            replace: true, currentValue: typeof ready.value === 'string' ? ready.value : '',
          }, signal, draft);
          const afterInfo = await this.#t2NodeInfoQuiet(resolvedTarget.objectId, signal);
          entry.nodeAfter = this.#t2NodeState(afterInfo);
          if (inserted.matched !== true) throw this.#t2NotInteractable('value-mismatch', { fieldIndex: field.index });
          results.push({ index: field.index, type: field.type, changed: true, ok: true, nodeBefore: entry.nodeBefore, nodeAfter: entry.nodeAfter, eventSource: 'cdp-input' });
        } else if (field.type === 'checkbox' || field.type === 'radio') {
          let changed = false;
          if (Boolean(ready.checked) !== field.value) {
            await this.#t2MouseClick(ready, { button: 'left', clickCount: 1, modifiers: [] }, signal, draft);
            changed = true;
          }
          const afterInfo = await this.#t2NodeInfoQuiet(resolvedTarget.objectId, signal);
          entry.nodeAfter = this.#t2NodeState(afterInfo);
          if (!afterInfo || afterInfo.checked !== true) throw this.#t2NotInteractable('value-mismatch', { fieldIndex: field.index });
          results.push({ index: field.index, type: field.type, changed, ok: true, nodeBefore: entry.nodeBefore, nodeAfter: entry.nodeAfter, eventSource: 'cdp-input' });
        } else if (field.type === 'combobox') {
          const values = field.value;
          const applied = await this.#t2Call(resolvedTarget.objectId, T2_SELECT_WRITE_FN, [{ values }], signal);
          draft.dispatch.started = true;
          draft.dispatch.eventSource = 'dom-control';
          draft.dispatch.eventCount += 1;
          draft.dispatch.completed = true;
          if (!applied || applied.ok !== true) throw this.#t2NotInteractable('type-mismatch', { fieldIndex: field.index, reason: applied && applied.reason });
          if (applied.missing.length) throw this.#t2NotInteractable('type-mismatch', { fieldIndex: field.index, missingCount: applied.missing.length });
          if (applied.unavailable.length) throw this.#t2NotInteractable('disabled', { fieldIndex: field.index, unavailableCount: applied.unavailable.length });
          const afterInfo = await this.#t2NodeInfoQuiet(resolvedTarget.objectId, signal);
          entry.nodeAfter = this.#t2NodeState(afterInfo);
          if (!afterInfo) throw this.#t2NotInteractable('detached', { fieldIndex: field.index });
          const actual = Array.isArray(afterInfo.value) ? afterInfo.value : [String(afterInfo.value === null || afterInfo.value === undefined ? '' : afterInfo.value)];
          if (actual.length !== values.length || values.some((item) => !actual.includes(item))) {
            throw this.#t2NotInteractable('value-mismatch', { fieldIndex: field.index });
          }
          const before = applied.before === undefined ? null : applied.before;
          const changed = JSON.stringify(before) !== JSON.stringify(actual);
          results.push({ index: field.index, type: field.type, changed, ok: true, nodeBefore: entry.nodeBefore, nodeAfter: entry.nodeAfter, eventSource: 'dom-control' });
        } else {
          const applied = await this.#t2Call(resolvedTarget.objectId, T2_VALUE_WRITE_FN, [{ value: field.value }], signal);
          draft.dispatch.started = true;
          draft.dispatch.eventSource = 'dom-control';
          draft.dispatch.eventCount += 1;
          draft.dispatch.completed = true;
          if (!applied || applied.ok !== true) throw this.#t2NotInteractable('type-mismatch', { fieldIndex: field.index, reason: applied && applied.reason });
          const afterInfo = await this.#t2NodeInfoQuiet(resolvedTarget.objectId, signal);
          entry.nodeAfter = this.#t2NodeState(afterInfo);
          if (!afterInfo) throw this.#t2NotInteractable('detached', { fieldIndex: field.index });
          if (String(afterInfo.value) !== String(field.value)) throw this.#t2NotInteractable('value-mismatch', { fieldIndex: field.index });
          results.push({
            index: field.index, type: field.type, changed: String(applied.before) !== String(applied.after), ok: true,
            nodeBefore: entry.nodeBefore, nodeAfter: entry.nodeAfter, eventSource: 'dom-control',
          });
        }
      }
      failedIndex = null;
      await this.#t2Observe(draft, 'after', signal);
      this.#t2ReleaseGroup('t2-action');
      return { ok: true, applied: results.length, fields: results, evidence: this.#t2BuildEvidence(draft) };
    } catch (error) {
      const classified = asBrowserError(error);
      classified.details = {
        ...(classified.details && typeof classified.details === 'object' ? classified.details : {}),
        applied: results.length,
        failedIndex,
        fields: results,
      };
      return this.#t2Fail(classified, draft, signal);
    }
  }

  /* ---------------------------------------------------------------------------------------
   * browser_node_state
   * ------------------------------------------------------------------------------------- */
  async nodeState(args, signal) {
    const draft = this.#t2Draft('browser_node_state', 'document');
    try {
      const options = t2Object(args || {}, 'args');
      t2RejectUnknown(options, ['ref', 'selector'], 'browser_node_state');
      const target = t2RefOrSelector(options, { name: '' });
      draft.source = target.kind;
      await this.ensure(signal);
      await this.#t2Observe(draft, 'before', signal);
      const entry = this.#t2TargetShell(target);
      draft.targets.push(entry);
      const resolvedTarget = await this.#t2ResolveTarget(target, signal);
      const verified = await this.#t2VerifyIdentity(resolvedTarget, signal);
      this.#t2FillTargetEntry(entry, target, verified);
      await this.#t2Observe(draft, 'after', signal);
      this.#t2ReleaseGroup('t2-action');
      return { ok: true, node: entry.nodeBefore, evidence: this.#t2BuildEvidence(draft) };
    } catch (error) {
      return this.#t2Fail(error, draft, signal);
    }
  }

  /* ---------------------------------------------------------------------------------------
   * browser_wait_for
   * ------------------------------------------------------------------------------------- */
  async waitFor(args, signal) {
    const draft = this.#t2Draft('browser_wait_for', 'document');
    try {
      const options = t2Object(args || {}, 'args');
      t2RejectUnknown(options, ['text', 'textGone', 'ref', 'selector', 'state', 'timeoutMs', 'pollMs'], 'browser_wait_for');
      const hasText = options.text !== undefined && options.text !== null;
      const hasTextGone = options.textGone !== undefined && options.textGone !== null;
      const target = t2RefOrSelector(options, { exactlyOne: false, allowNone: true });
      const groups = [hasText, hasTextGone, Boolean(target)].filter(Boolean).length;
      if (groups !== 1) throw t2InvalidArgument('wait_for 条件必须恰好属于一类：text / textGone / (ref|selector + state)');
      const text = hasText ? t2StringField(options.text, { name: 'text', maxBytes: T2_LIMITS.waitValueBytes, allowEmpty: true }) : null;
      const textGone = hasTextGone ? t2StringField(options.textGone, { name: 'textGone', maxBytes: T2_LIMITS.waitValueBytes, allowEmpty: true }) : null;
      let state = null;
      if (target) {
        if (options.state === undefined || options.state === null) state = { visible: true };
        else {
          const rawState = t2Object(options.state, 'state');
          t2RejectUnknown(rawState, [...T2_WAIT_STATE_KEYS], 'state');
          state = {};
          for (const key of ['visible', 'enabled', 'checked']) {
            if (rawState[key] !== undefined && rawState[key] !== null) state[key] = t2BooleanField(rawState[key], undefined, `state.${key}`);
          }
          if (rawState.valueEquals !== undefined && rawState.valueEquals !== null) {
            state.valueEquals = t2StringField(rawState.valueEquals, { name: 'state.valueEquals', maxBytes: T2_LIMITS.waitValueBytes, allowEmpty: true });
          }
          if (Object.keys(state).length === 0) throw t2InvalidArgument(`state 至少要有一个条件（${T2_WAIT_STATE_KEYS.join('/')}）`);
        }
      } else if (options.state !== undefined && options.state !== null) {
        throw t2InvalidArgument('state 条件必须与 ref 或 selector 一起使用');
      }
      const timeoutMs = t2IntegerField(options.timeoutMs, T2_LIMITS.waitDefaultTimeoutMs, 0, T2_LIMITS.waitMaxTimeoutMs, 'timeoutMs');
      const pollMs = t2IntegerField(options.pollMs, T2_LIMITS.waitDefaultPollMs, T2_LIMITS.waitMinPollMs, T2_LIMITS.waitMaxPollMs, 'pollMs');
      draft.source = target ? target.kind : 'document';
      await this.ensure(signal);
      await this.#t2Observe(draft, 'before', signal);
      const condition = {
        text: hasText ? true : null,
        textGone: hasTextGone ? true : null,
        target: target ? t2Requested(target).kind : null,
        state,
      };
      const entry = this.#t2TargetShell(target);
      if (target) draft.targets.push(entry);
      const startedAt = Date.now();
      let polls = 0;
      let last = null;
      for (;;) {
        checkAbort(signal);
        polls += 1;
        const polled = await this.#t2PollWait({ target, state, text, textGone }, signal);
        last = polled.observation;
        if (polled.satisfied) {
          if (polled.resolved) entry.resolved = polled.resolved;
          entry.nodeAfter = polled.node;
          await this.#t2Observe(draft, 'after', signal);
          this.#t2ReleaseGroup('t2-action');
          return {
            ok: true,
            matched: true,
            elapsedMs: Date.now() - startedAt,
            polls,
            condition,
            node: polled.node,
            evidence: this.#t2BuildEvidence(draft),
          };
        }
        const elapsed = Date.now() - startedAt;
        if (timeoutMs === 0 || elapsed >= timeoutMs) {
          throw new BrowserError('WAIT_TIMEOUT', `等待条件在 ${timeoutMs}ms 预算内未成立（${polls} 次采样）`, {
            timeoutMs, elapsedMs: elapsed, polls, condition, lastObservation: last,
          });
        }
        await abortable(delay(Math.min(pollMs, Math.max(1, timeoutMs - elapsed))), signal);
      }
    } catch (error) {
      return this.#t2Fail(error, draft, signal);
    }
  }

  /**
   * One wait sample.
   *
   * Text conditions read `document.body.innerText` (main frame only). A target condition resolves
   * the ref/selector; a selector with 0 matches only satisfies `visible:false`, while a stale ref is
   * always REF_STALE (contract §4.4) — never silently "detached".
   */
  async #t2PollWait({ target, state, text, textGone }, signal) {
    if (text !== null || textGone !== null) {
      const result = await this.send('Runtime.evaluate', {
        expression: '(() => { const body = document.body; return { text: body && typeof body.innerText === "string" ? body.innerText.slice(0, 200000) : "" }; })()',
        returnByValue: true,
      }, signal);
      const bodyText = String((result && result.result && result.result.value && result.result.value.text) || '');
      const present = text !== null ? bodyText.includes(text) : true;
      const absent = textGone !== null ? !bodyText.includes(textGone) : true;
      return { satisfied: present && absent, node: null, resolved: null, observation: { textLength: bodyText.length } };
    }
    let resolvedTarget = null;
    let missing = false;
    try {
      resolvedTarget = await this.#t2ResolveTarget(target, signal);
    } catch (error) {
      const classified = asBrowserError(error);
      if (target.kind === 'selector' && classified.code === 'TARGET_NOT_FOUND') missing = true;
      else throw classified;
    }
    if (missing) {
      return { satisfied: state.visible === false, node: null, resolved: null, observation: { attached: false } };
    }
    const verified = await this.#t2VerifyIdentity(resolvedTarget, signal);
    const info = verified.info;
    const node = this.#t2NodeState(info);
    let satisfied = true;
    const observation = {};
    if (state.visible !== undefined) {
      observation.visible = info.visible === true;
      if (observation.visible !== state.visible) satisfied = false;
    }
    if (state.enabled !== undefined) {
      observation.enabled = info.enabled === true;
      if (observation.enabled !== state.enabled) satisfied = false;
    }
    if (state.checked !== undefined) {
      if (info.checked === null || info.checked === undefined) throw t2InvalidArgument('state.checked 只适用于带 checked 状态的控件');
      observation.checked = info.checked === true;
      if (observation.checked !== state.checked) satisfied = false;
    }
    if (state.valueEquals !== undefined) {
      if (info.value === null || info.value === undefined) throw t2InvalidArgument('state.valueEquals 只适用于表单控件');
      const current = Array.isArray(info.value) ? info.value.join(',') : String(info.value);
      observation.valueEquals = current === state.valueEquals;
      if (!observation.valueEquals) satisfied = false;
    }
    return {
      satisfied,
      node: satisfied ? node : null,
      resolved: this.#t2Resolved(target, verified),
      observation,
    };
  }

  async close() {
    // One shared promise: concurrent closes (panel /close, abort cleanup, plugin unload) all wait
    // for the same teardown instead of racing it.
    if (this.closing) return this.closing;
    this.closing = this.#doClose().finally(() => { this.closing = undefined; });
    return this.closing;
  }

  async #doClose() {
    // Invalidate every metadata read still in flight: after close no old URL may be republished.
    this.metadataGeneration += 1;
    this.metadataInFlight = false;
    this.metadataDirty = false;
    if (this.metadataRetryTimer) { clearTimeout(this.metadataRetryTimer); this.metadataRetryTimer = 0; }
    this.mainFrameId = undefined;
    this.history = emptyHistory();
    // Do not race a lazily starting page: let it settle, then tear the result down.
    if (this.starting) {
      try { await this.starting; } catch { /* start failure already cleaned up */ }
    }
    try { if (this.frameTransport) this.frameTransport.closeClients(); } catch { /* ignore */ }
    try { if (this.cdp && !this.cdp.closed) await this.cdp.send('Page.stopScreencast', {}, { timeoutMs: 200 }); } catch { /* ignore */ }
    try { if (this.cdpOff) this.cdpOff(); } catch { /* ignore */ }
    this.cdpOff = undefined;
    try { if (this.cdp) this.cdp.close(); } catch { /* ignore */ }
    this.cdp = undefined;
    // Capture the page BEFORE clearing it: a close racing an ensure must only ever close the
    // target that belonged to this generation, never the target the ensure just created.
    const closedPage = this.page;
    this.page = undefined;
    // Only this runtime's own page target is closed. The shared browser, the other workspaces'
    // pages and the temporary profile belong to the BrowserHost.
    try { await this.host.closePage(this, closedPage?.targetId); } catch { /* ignore */ }

    this.frames.stop();
    // Network collector teardown: release held requests (never leave a paused request behind),
    // stop collecting, drop child-session bookkeeping. Exported evidence files stay on disk.
    try { await this.#netReleaseAllHeld(); } catch { /* ignore */ }
    try { await this.#netDisarmAutoAttach(); } catch { /* ignore */ }
    this.netTargets.clear();
    this.netReq.clear();
    this.netHops.clear();
    this.netCacheHits.clear();
    if (this.net) this.net.stop();
    this.network.length = 0;
    this.requests.clear();
    this.url = '';
    this.title = '';
    this.clearError();
    this.activity = '空闲';
    this.ackFailures = 0;
    this.clientMetrics = undefined;
    this.lease = undefined;
    this.agentUntil = 0;
    this.humanUntil = 0;
    this.metadataStartedAt = 0;
    this.navigationError = undefined;
    // A closed page keeps its width/height/scale configuration but loses its page-bound position
    // (docs/viewport-control.md §3.1): x/y reset to 0, the observation is dropped, and the
    // revision moves because that *is* a content change (never silently reuse the old position).
    if (this.viewObserveTimer) { clearTimeout(this.viewObserveTimer); this.viewObserveTimer = 0; }
    this.viewObserveDue = [];
    this.viewObserving = false;
    this.viewObserveAt = 0;
    const hadViewPosition = this.view.x !== 0 || this.view.y !== 0 || this.observed !== null;
    this.view.x = 0;
    this.view.y = 0;
    this.observed = null;
    this.viewOriginId = null;
    if (hadViewPosition) this.view.revision += 1;
    this.viewerUntil = 0;
    this.viewerSockets = 0;
    // Refs never survive a close/eviction/rebuild (contract §3.2).
    this.#t2BumpDocumentEpoch();

    if (this.ownsHost) {
      // Legacy private runtime: close the process/profile exactly like before.
      try { await this.host.close(); } catch { /* ignore */ }
    } else {
      // The plugin-wide host exits only when the last page is gone and nothing is being created.
      try { await this.registry?.maybeCloseHost(); } catch { /* ignore */ }
    }
  }
}


/* ---------------------------------------------------------------------------------------------
 * Scope request parsing (HTTP headers / WS query) and resolution.
 * ------------------------------------------------------------------------------------------- */
const SCOPE_HEADER_VERSION = 'x-ui-testing-scope-version';
const SCOPE_HEADER_SESSION = 'x-ui-testing-session-id';
const SCOPE_HEADER_SCOPE = 'x-ui-testing-scope';
const SCOPE_HEADER_BINDING = 'x-ui-testing-scope-binding';
const SCOPE_SPECIAL_VALUES = new Set(['recent', 'unassigned']);

function headerValue(headers, name) {
  const raw = headers ? headers[name] : undefined;
  if (raw === undefined || raw === null) return undefined;
  if (Array.isArray(raw)) return raw.length ? String(raw[0]) : undefined;
  return String(raw);
}

function scopeToken(value, name) {
  if (typeof value !== 'string') return undefined;
  const text = value.trim();
  if (!text) return undefined;
  if (text.length > 256 || /[\u0000-\u001f\u007f]/u.test(text)) throw new BrowserError('SCOPE_INVALID', `${name} 不合法`);
  return text;
}

function scopeSpecial(value) {
  const text = String(value).trim().toLowerCase();
  if (!SCOPE_SPECIAL_VALUES.has(text)) throw new BrowserError('SCOPE_INVALID', `scope 只支持 recent/unassigned，收到 ${value}`);
  return { mode: text };
}

/**
 * HTTP scope protocol. No scope headers at all = the old protocol (`legacy:default`); any scope
 * header without a protocol version, or two different identities in one request, is a 400.
 */
function parseHttpScope(req) {
  const headers = (req && req.headers) || {};
  const version = headerValue(headers, SCOPE_HEADER_VERSION);
  const sessionId = headerValue(headers, SCOPE_HEADER_SESSION);
  const special = headerValue(headers, SCOPE_HEADER_SCOPE);
  const binding = headerValue(headers, SCOPE_HEADER_BINDING);
  const present = [version, sessionId, special, binding].filter((value) => value !== undefined && value !== '');
  if (present.length === 0) return { mode: 'legacy' };
  if (version === undefined || version === '') throw new BrowserError('SCOPE_INVALID', `缺少 ${SCOPE_HEADER_VERSION}`);
  if (version !== '1') throw new BrowserError('SCOPE_INVALID', `不支持的 scope 版本：${version}`);
  const identities = [sessionId, special, binding].filter((value) => value !== undefined && value !== '');
  if (identities.length > 1) throw new BrowserError('SCOPE_INVALID', '同一请求只能给出一种 scope 身份（sessionId / scope / binding）');
  if (identities.length === 0) throw new BrowserError('SCOPE_INVALID', 'scopeVersion=1 必须给出 sessionId、scope 或 binding');
  if (binding) return { mode: 'binding', runtimeId: scopeToken(binding, 'binding') };
  if (special) return scopeSpecial(special);
  return { mode: 'session', sessionId: scopeToken(sessionId, 'sessionId') };
}

/** The WS query form of the same protocol: ?scopeVersion=1&sessionId=… / &scope=… / &binding=… */
function parseScopeQuery(rawUrl) {
  let url;
  try { url = new URL(rawUrl || '/', 'http://localhost'); }
  catch { throw new BrowserError('SCOPE_INVALID', '非法的 WebSocket 地址'); }
  const version = url.searchParams.get('scopeVersion');
  const sessionId = url.searchParams.get('sessionId');
  const special = url.searchParams.get('scope');
  const binding = url.searchParams.get('binding');
  if (version === null) {
    if (sessionId !== null || special !== null || binding !== null) throw new BrowserError('SCOPE_INVALID', '缺少 scopeVersion');
    return { mode: 'legacy' };
  }
  if (version !== '1') throw new BrowserError('SCOPE_INVALID', `不支持的 scope 版本：${version}`);
  const identities = [sessionId, special, binding].filter((value) => value !== null && value !== '');
  if (identities.length > 1) throw new BrowserError('SCOPE_INVALID', '同一连接只能给出一种 scope 身份（sessionId / scope / binding）');
  if (identities.length === 0) throw new BrowserError('SCOPE_INVALID', 'scopeVersion=1 必须给出 sessionId、scope 或 binding');
  if (binding) return { mode: 'binding', runtimeId: scopeToken(binding, 'binding') };
  if (special) return scopeSpecial(special);
  return { mode: 'session', sessionId: scopeToken(sessionId, 'sessionId') };
}

/** Status for the workspace-isolation error taxonomy (everything else stays 500 for compat). */
function scopeHttpStatus(code) {
  switch (code) {
    // Optimistic-concurrency loss on the shared viewport (docs/viewport-control.md §7.1).
    case 'VIEWPORT_CONFLICT': return 409;
    case 'SCOPE_INVALID': return 400;
    case 'SCOPE_FORBIDDEN': return 403;
    case 'SCOPE_NOT_FOUND': return 404;
    case 'SCOPE_UNAVAILABLE': return 503;
    case 'RUNTIME_LIMIT': return 503;
    default: return 500;
  }
}

function hostService(ctx, name) {
  try {
    if (ctx && typeof ctx.get === 'function') {
      const value = ctx.get(name);
      if (value !== undefined) return value;
    }
  } catch { /* fall back to the property form */ }
  try { return ctx ? ctx[name] : undefined; } catch { return undefined; }
}

/**
 * Resolve one session id (optionally with the Agent's own `exec.agent.session.header.cwd`) to a
 * scope. The cwd is only a *lookup hint*: the canonical workspace id always comes from the DSH
 * workspace registry's exact realpath match. Absolute paths never leave this function.
 */
async function resolveSessionScope(ctx, sessionId, { cwd, signal } = {}) {
  let dir = typeof cwd === 'string' && cwd ? cwd : undefined;
  let liveSession = false;
  if (!dir) {
    const sessions = hostService(ctx, 'sessions');
    if (sessions && typeof sessions.get === 'function') {
      let session;
      try { session = sessions.get(sessionId); }
      catch { throw new BrowserError('SCOPE_UNAVAILABLE', '会话服务读取失败', { scope: 'session' }); }
      if (session) {
        liveSession = true;
        const headerCwd = session.header && session.header.cwd;
        if (typeof headerCwd === 'string' && headerCwd) dir = headerCwd;
      }
    }
  }
  if (!dir) {
    const persistence = hostService(ctx, 'sessionPersistence');
    if (persistence && typeof persistence.stat === 'function') {
      let stat;
      try { stat = await persistence.stat(sessionId, signal ? { signal } : undefined); }
      catch (error) {
        if (signal?.aborted) throw new BrowserError('ABORTED', '操作已取消');
        throw new BrowserError('SCOPE_UNAVAILABLE', '会话存储读取失败', { scope: 'session' });
      }
      if (stat === undefined) {
        // `undefined` is the only "definitely absent" answer; a thrown error is a 503 above.
        if (!liveSession) throw new BrowserError('SCOPE_NOT_FOUND', '会话不存在', { scope: 'session' });
      } else {
        const headerCwd = stat && stat.header && stat.header.cwd;
        if (typeof headerCwd === 'string' && headerCwd) dir = headerCwd;
        else liveSession = true;
      }
    }
  }
  const registryService = hostService(ctx, 'workspaceRegistry');
  const rescueBySession = () => {
    if (!registryService || typeof registryService.list !== 'function') return undefined;
    let list;
    try { list = registryService.list(); }
    catch { throw new BrowserError('SCOPE_UNAVAILABLE', '工作区注册表读取失败', { scope: 'workspace' }); }
    if (!Array.isArray(list)) return undefined;
    const matches = list.filter((workspace) => workspace && typeof workspace.id === 'string'
      && Array.isArray(workspace.sessionIds) && workspace.sessionIds.includes(sessionId));
    return matches.length === 1 ? workspaceScope(matches[0].id) : undefined;
  };
  const missingPath = (error) => Boolean(error) && (error.code === 'ENOENT' || error.code === 'ENOTDIR');
  if (dir) {
    let canonical;
    try { canonical = await realpath(dir); }
    catch (error) {
      // ENOENT/ENOTDIR: the directory is gone -> membership rescue or a degraded scope.
      // EACCES/EIO/...: a storage/permission fault, never "unregistered directory".
      if (!missingPath(error)) throw new BrowserError('SCOPE_UNAVAILABLE', '工作目录不可读', { scope: 'path' });
      canonical = undefined;
    }
    if (canonical) {
      if (registryService && typeof registryService.resolveByPath === 'function') {
        let workspace;
        try {
          // DSH WorkspaceRegistry.resolveByPath returns Promise<Workspace | undefined>.
          workspace = await registryService.resolveByPath(canonical);
        } catch (error) {
          // A path removed between realpath() and the registry lookup is a missing directory,
          // not a registry fault: membership rescue first, then the degraded path scope (we still
          // hold the canonical spelling from realpath()).
          if (missingPath(error)) {
            const rescuedOnRace = rescueBySession();
            if (rescuedOnRace) return rescuedOnRace;
            return pathScope(canonical);
          }
          throw new BrowserError('SCOPE_UNAVAILABLE', '工作区注册表读取失败', { scope: 'workspace' });
        }
        if (workspace && typeof workspace.id === 'string' && workspace.id) return workspaceScope(workspace.id);
      }
      // Exact realpath equality only: a parent directory must never claim a nested workspace.
      const rescued = rescueBySession();
      if (rescued) return rescued;
      return pathScope(canonical);
    }
    const rescued = rescueBySession();
    if (rescued) return rescued;
  }
  if (!sessionId) return UNASSIGNED_SCOPE;
  return sessionScope(sessionId);
}

/** Tools carry the Agent's session header; no exec identity at all is the old protocol. */
function toolScopeRequest(exec) {
  const agent = exec && exec.agent;
  if (!agent || !agent.id) return { mode: 'legacy' };
  const headerCwd = agent.session && agent.session.header && agent.session.header.cwd;
  return {
    mode: 'session',
    sessionId: String(agent.id),
    ...(typeof headerCwd === 'string' && headerCwd ? { cwd: headerCwd } : {}),
    ...(exec && exec.signal ? { signal: exec.signal } : {}),
  };
}

/**
 * Resolve a parsed scope request to { key, scope }. A `binding` must hit an existing runtime
 * (404 otherwise) and is owner-only at the HTTP/WS layer; `recent` never falls back to legacy.
 */
async function resolveScopeRequest(ctx, registry, request) {
  if (!request || request.mode === 'legacy') return LEGACY_SCOPE;
  if (request.mode === 'unassigned') return UNASSIGNED_SCOPE;
  if (request.mode === 'recent') {
    const entry = registry.recentEntry();
    return entry ? { key: entry.key, scope: entry.scope } : UNASSIGNED_SCOPE;
  }
  if (request.mode === 'binding') {
    const entry = registry.findByRuntimeId(request.runtimeId);
    if (!entry) throw new BrowserError('SCOPE_NOT_FOUND', 'scope binding 指向的运行时不存在', { scope: 'binding' });
    return { key: entry.key, scope: entry.scope };
  }
  // Bounded: tools pass exec.signal; HTTP/WS requests get a 5s metadata-read budget.
  return resolveSessionScope(ctx, request.sessionId, { cwd: request.cwd, signal: request.signal || AbortSignal.timeout(5000) });
}

function emptyMetrics() {
  return {
    ok: true,
    now: Date.now(),
    host: {
      seq: 0, epoch: 0, url: '', captured: 0, cachedOnly: 0, subscribers: 0,
      captureFps: 0, captureIntervalMs: 0, measured: { captureFps: false, captureIntervalMs: false },
      lastFrame: null, ackFailures: 0, push: null, cleanupError: null,
    },
    client: null,
  };
}

/**
 * Per-scope Runtime registry.
 *
 * - `getOrCreate` returns a cold Runtime (no page, no Chromium) so /state and /frames have a
 *   stable runtimeId; only an actual page operation starts the shared BrowserHost.
 * - `reservePageSlot` counts a reservation BEFORE any await that could create a page, so N
 *   concurrent first ensures cannot exceed `maxPages`; eligible idle LRU pages are evicted first.
 * - `recent` is updated only by real interaction / successful operations, never by polling, and
 *   never points at `legacy:default`.
 */
export class RuntimeRegistry {
  constructor({ log, ctx, origins, maxPages = MAX_PAGES_DEFAULT, idleMs = IDLE_MS_DEFAULT, maxEntries = MAX_ENTRIES_DEFAULT, viewerTtlMs = VIEWER_TTL_MS }) {
    this.log = log;
    this.ctx = ctx;
    this.origins = origins;
    this.maxPages = maxPages;
    this.idleMs = idleMs;
    this.maxEntries = maxEntries;
    this.viewerTtlMs = viewerTtlMs;
    this.entries = new Map();
    this.host = undefined;
    this.reservations = 0;
    this.recentKey = undefined;
    this.disposed = false;
    this.sweeping = false;
    this.sweepTimer = setInterval(() => { this.sweep().catch(() => {}); }, Math.max(1000, Math.min(60000, Math.floor(idleMs / 4))));
    this.sweepTimer.unref?.();
  }

  get pageCount() { return this.host ? this.host.pageCount : 0; }

  browserHost() {
    if (!this.host) this.host = new BrowserHost(this.log);
    return this.host;
  }

  peek(key) { return this.entries.get(key); }

  getOrCreate(resolved) {
    if (this.disposed) throw new BrowserError('SCOPE_UNAVAILABLE', '插件正在卸载');
    const { key, scope } = resolved;
    const existing = this.entries.get(key);
    if (existing) return existing;
    if (this.entries.size >= this.maxEntries) this.#evictColdEntry();
    const runtime = new Runtime(this.log, { host: this.browserHost(), origins: this.origins, scope, registry: this, viewerTtlMs: this.viewerTtlMs });
    const entry = { key, scope, runtime, createdAt: Date.now(), lastUsedAt: Date.now() };
    this.entries.set(key, entry);
    return entry;
  }

  findByRuntimeId(runtimeId) {
    if (typeof runtimeId !== 'string' || !runtimeId) return undefined;
    for (const entry of this.entries.values()) if (entry.runtime.runtimeId === runtimeId) return entry;
    return undefined;
  }

  recentEntry() { return this.recentKey ? this.entries.get(this.recentKey) : undefined; }

  markRecent(entry) {
    if (!entry || entry.key === LEGACY_SCOPE.key) return;
    this.recentKey = entry.key;
  }

  touch(entry) { if (entry) entry.lastUsedAt = Date.now(); }

  /**
   * Reserve one page slot. The reservation is visible to `pageCount + reservations` before the
   * first await, so nine concurrent cold ensures cannot all pass the cap.
   */
  async reservePageSlot(runtime) {
    if (this.disposed) throw new BrowserError('SCOPE_UNAVAILABLE', '插件正在卸载');
    await this.sweep();
    const host = this.browserHost();
    if (runtime.page) return () => {};
    this.reservations += 1;
    let released = false;
    const release = () => {
      if (released) return;
      released = true;
      this.reservations = Math.max(0, this.reservations - 1);
    };
    try {
      while (host.pageCount + this.reservations > this.maxPages) {
        const victim = this.#evictable(runtime);
        if (!victim) {
          throw new BrowserError('RUNTIME_LIMIT', `同时最多 ${this.maxPages} 个页面实例，且没有可回收的空闲实例`, {
            maxPages: this.maxPages, pageCount: host.pageCount, reservations: this.reservations,
          });
        }
        this.log(`evicting idle scope ${victim.scope.id} (inflight=${victim.runtime.inflight} active=${victim.runtime.active} lease=${Boolean(victim.runtime.hasLease())} viewers=${victim.runtime.viewers} page=${Boolean(victim.runtime.page)}) to make room for ${runtime.scope.id}`);
        try { await victim.runtime.close(); } catch (error) { this.log('evict failed: ' + String((error && error.message) || error)); }
      }
      return release;
    } catch (error) {
      release();
      throw error;
    }
  }

  /** LRU candidate: has its own page, no in-flight operation, no valid lease, no visible viewer. */
  #evictable(exceptRuntime) {
    let best;
    for (const entry of this.entries.values()) {
      const runtime = entry.runtime;
      if (runtime === exceptRuntime) continue;
      if (!runtime.page) continue;
      if (!runtime.evictable()) continue;
      if (!best || entry.lastUsedAt < best.lastUsedAt) best = entry;
    }
    return best;
  }

  #evictColdEntry() {
    let best;
    for (const entry of this.entries.values()) {
      if (entry.runtime.page) continue;
      if (!best || entry.lastUsedAt < best.lastUsedAt) best = entry;
    }
    if (!best) throw new BrowserError('RUNTIME_LIMIT', 'scope 实例数量达到上限，且没有可回收的空闲实例', { maxEntries: this.maxEntries });
    this.#retire(best);
  }

  #retire(entry) {
    this.entries.delete(entry.key);
    if (this.recentKey === entry.key) this.recentKey = undefined;
    try { this.onRetire?.(entry.runtime); } catch { /* ignore */ }
    try { entry.runtime.frameTransport?.dispose?.(); } catch { /* ignore */ }
    // A retired scope runtime is gone: its stored images must not outlive it (a later productId
    // then reports VISION_SOURCE_NOT_FOUND exactly like a restart).
    try { entry.runtime.disposeVision?.(); } catch { /* ignore */ }
  }

  /** Idle sweep: only entries with no active op, no valid lease, no visible viewer, no in-flight. */
  async sweep() {
    if (this.disposed || this.sweeping) return;
    this.sweeping = true;
    try {
      const now = Date.now();
      for (const entry of [...this.entries.values()]) {
        if (entry.key === LEGACY_SCOPE.key) continue; // old client compatibility: keep the entry
        const runtime = entry.runtime;
        const idleFor = now - entry.lastUsedAt;
        if (idleFor < this.idleMs) continue;
        if (runtime.page) {
          if (!runtime.evictable()) continue;
          // Restart the idle window before the (possibly slow) close: a concurrent/next sweep
          // must not retire the cold entry while the host is still shutting down.
          entry.lastUsedAt = Date.now();
          try { await runtime.close(); } catch { /* ignore */ }
          entry.lastUsedAt = Date.now();
        } else {
          // A cold entry may still have an ensure/operation in flight (e.g. the shared host is
          // restarting); retiring it here would orphan the page the operation is creating.
          if (runtime.inflight > 0 || runtime.starting || runtime.closing || runtime.hasLease() || runtime.viewers > 0) continue;
          this.#retire(entry);
        }
      }
    } finally {
      this.sweeping = false;
    }
  }

  /** The shared host exits only when the last page is gone and no create is in flight. */
  async maybeCloseHost() {
    if (this.disposed) return;
    if (this.reservations > 0) return;
    const host = this.host;
    if (!host) return;
    if (host.pageCount > 0 || host.pendingCreates > 0 || host.starting) return;
    if (host.closing) return host.closing;
    if (!host.proc && !host.profileDir && !host.browserCdp) return undefined;
    return host.close();
  }

  releaseSession(sessionId) {
    for (const entry of this.entries.values()) entry.runtime.release(sessionId);
  }

  capabilities() {
    return {
      page: true,
      cookie: false,
      cache: false,
      maxPages: this.maxPages,
      idleMs: this.idleMs,
      pages: this.pageCount,
      entries: this.entries.size,
      viewerTtlMs: this.viewerTtlMs,
    };
  }

  async dispose() {
    if (this.disposed) return;
    this.disposed = true;
    clearInterval(this.sweepTimer);
    const runtimes = [...this.entries.values()].map((entry) => entry.runtime);
    this.entries.clear();
    this.recentKey = undefined;
    for (const runtime of runtimes) {
      try { await runtime.close(); } catch { /* ignore */ }
      try { this.onRetire?.(runtime); } catch { /* ignore */ }
      try { runtime.frameTransport?.dispose?.(); } catch { /* ignore */ }
      try { runtime.disposeVision?.(); } catch { /* ignore */ }
    }
    if (this.host) { try { await this.host.close(); } catch { /* ignore */ } }
  }
}

function waitForExit(proc, timeoutMs) {
  if (!proc || proc.exitCode !== null) return Promise.resolve(true);
  return new Promise((resolve) => {
    let settled = false;
    const timer = setTimeout(() => finish(false), timeoutMs);
    timer.unref?.();
    function finish(value) {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      proc.removeListener('exit', onExit);
      resolve(value);
    }
    function onExit() { finish(true); }
    proc.once('exit', onExit);
  });
}

function readJson(req) {
  return new Promise((resolve, reject) => {
    const chunks = [];
    let size = 0;
    req.on('data', (chunk) => {
      size += chunk.length;
      if (size > 8388608) {
        reject(new BrowserError('INVALID_ARGUMENT', '请求体过大'));
        req.destroy();
        return;
      }
      chunks.push(chunk);
    });
    req.on('end', () => {
      const text = Buffer.concat(chunks).toString('utf8');
      if (!text) return resolve({});
      try { resolve(JSON.parse(text)); } catch { reject(new BrowserError('INVALID_ARGUMENT', '请求体不是合法 JSON')); }
    });
    req.on('error', reject);
  });
}

function sendJson(res, status, value) {
  res.writeHead(status, {
    'content-type': 'application/json; charset=utf-8',
    'cache-control': 'no-store',
  });
  res.end(JSON.stringify(value));
}


/* ---------------------------------------------------------------------------------------------
 * Independent HTTP(S) client — `browser_http_request` / `web.t1.http-request`.
 *
 * Deliberately shares nothing with the page runtime: no Chromium, no CDP, no page queue, no
 * owner lease, no cookie jar, no page lastError. Contract: docs/t1-http-request.md.
 *
 * `node:http` / `node:https` are default-imported and called as `http.request(...)` so a probe
 * can wrap the module property to count dispatches (zero-dispatch assertions).
 * ------------------------------------------------------------------------------------------- */
const HTTP_METHODS = Object.freeze(['GET', 'HEAD', 'POST', 'PUT', 'PATCH', 'DELETE', 'OPTIONS']);
const HTTP_DEFAULTS = Object.freeze({ method: 'GET', timeoutMs: 5000, maxBytes: 65536, followRedirects: false, maxRedirects: 0 });
const HTTP_LIMITS = Object.freeze({
  urlBytes: 8192,
  headers: 64,
  headerNameChars: 128,
  headerValueBytes: 4096,
  requestHeaderBytes: 8192,
  bodyBytes: 65536,
  timeoutMsMin: 1,
  timeoutMsMax: 20000,
  maxBytesMin: 1,
  maxBytesMax: 1048576,
  maxRedirectsMax: 5,
  responseHeaderBytes: 16384,
});
const HTTP_ARG_KEYS = Object.freeze(['method', 'url', 'headers', 'body', 'timeoutMs', 'maxBytes', 'followRedirects', 'maxRedirects']);
/** Never forwarded from the caller: Node generates protocol headers itself; cookie is banned. */
const HTTP_DANGEROUS_HEADERS = new Set([
  'host', 'content-length', 'transfer-encoding', 'connection', 'proxy-connection', 'keep-alive',
  'te', 'trailer', 'upgrade', 'expect', 'cookie', 'cookie2', 'proxy-authorization',
  'proxy-authenticate', 'accept-encoding',
]);
const HTTP_SENSITIVE_HEADER_NAME = /token|key|secret|password|auth|code|session/iu;
/** Always masked entirely, regardless of the generic name pattern. */
const HTTP_SENSITIVE_HEADERS = new Set([
  'set-cookie', 'set-cookie2', 'cookie', 'cookie2', 'authorization', 'proxy-authorization',
  'www-authenticate', 'proxy-authenticate', 'authentication-info', 'proxy-authentication-info', 'x-api-key',
]);
const HTTP_URL_HEADER_NAMES = new Set(['location', 'content-location']);
const HTTP_REDIRECT_STATUS = new Set([301, 302, 303, 307, 308]);

function isPlainRecord(value) {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return false;
  const prototype = Object.getPrototypeOf(value);
  return prototype === null || prototype === Object.prototype;
}

function invalidHttp(message, details = {}) {
  return new BrowserError('INVALID_ARGUMENT', message, { operation: 'http-request', phase: 'validation', ...details });
}

function httpError(code, message, details = {}) {
  return new BrowserError(code, message, { operation: 'http-request', ...details });
}

function integerInRange(value, fallback, min, max, name) {
  if (value === undefined) return fallback;
  if (typeof value !== 'number' || !Number.isInteger(value) || Object.is(value, -0) || value < min || value > max) {
    throw invalidHttp(`${name} 必须是 ${min}–${max} 的整数`);
  }
  return value;
}

function booleanField(value, fallback, name) {
  if (value === undefined) return fallback;
  if (typeof value !== 'boolean') throw invalidHttp(`${name} 必须是布尔值`);
  return value;
}

/** Validate caller headers and normalize names to lower case (case-insensitive duplicates rejected). */
function validateHttpHeaders(value) {
  if (value === undefined) return {};
  if (!isPlainRecord(value)) throw invalidHttp('headers 必须是字符串键值普通对象（不接受数组、Headers 实例或嵌套值）');
  const entries = Object.entries(value);
  if (entries.length > HTTP_LIMITS.headers) throw invalidHttp(`headers 最多 ${HTTP_LIMITS.headers} 条`);
  const out = Object.create(null);
  const seen = new Set();
  let total = 0;
  for (const [rawName, headerValue] of entries) {
    if (typeof rawName !== 'string' || rawName.length === 0 || rawName.length > HTTP_LIMITS.headerNameChars
      || !/^[!#$%&'*+.^_`|~0-9A-Za-z-]+$/u.test(rawName)) {
      throw invalidHttp(`非法请求头名：${JSON.stringify(rawName)}`);
    }
    const name = rawName.toLowerCase();
    if (seen.has(name)) throw invalidHttp(`重名请求头（大小写不敏感）：${rawName}`);
    seen.add(name);
    if (HTTP_DANGEROUS_HEADERS.has(name) || name.startsWith('proxy-') || name.startsWith('sec-')) {
      throw invalidHttp(`禁止的请求头：${rawName}`);
    }
    if (typeof headerValue !== 'string') throw invalidHttp(`请求头 ${rawName} 的值必须是字符串`);
    if (/[\u0000-\u0008\u000a-\u001f\u007f]/u.test(headerValue)) throw invalidHttp(`请求头 ${rawName} 的值包含控制字符`);
    if (Buffer.byteLength(headerValue, 'utf8') > HTTP_LIMITS.headerValueBytes) {
      throw invalidHttp(`请求头 ${rawName} 的值超过 ${HTTP_LIMITS.headerValueBytes} 字节`);
    }
    total += Buffer.byteLength(rawName, 'utf8') + Buffer.byteLength(headerValue, 'utf8') + 4;
    out[name] = headerValue;
  }
  if (total > HTTP_LIMITS.requestHeaderBytes) throw invalidHttp(`请求头合计超过 ${HTTP_LIMITS.requestHeaderBytes} 字节`);
  return out;
}

function validateHttpBody(value, method) {
  if (value === undefined) return undefined;
  if (typeof value !== 'string') throw invalidHttp('body 只能是 UTF-8 字符串（自行 JSON.stringify，不自动设置 content-type）');
  if (method === 'GET' || method === 'HEAD') throw invalidHttp(`${method} 请求不能提供 body（包括空字符串）`);
  if (Buffer.byteLength(value, 'utf8') > HTTP_LIMITS.bodyBytes) throw invalidHttp(`body 超过 ${HTTP_LIMITS.bodyBytes} UTF-8 字节`);
  return value;
}

/** Whole-batch validation: nothing is dispatched (and Chromium is not touched) before this passes. */
function validateHttpRequest(args) {
  if (!isPlainRecord(args)) throw invalidHttp('参数必须是普通 JSON 对象');
  const unknown = Object.keys(args).filter((key) => !HTTP_ARG_KEYS.includes(key));
  if (unknown.length) throw invalidHttp(`未知参数：${unknown.join(', ')}`);
  const rawUrl = args.url;
  if (typeof rawUrl !== 'string' || rawUrl.length === 0) throw invalidHttp('url 必须是非空字符串');
  if (/^\s|\s$/u.test(rawUrl)) throw invalidHttp('url 不能有前后空白');
  if (/[\u0000-\u001f\u007f]/u.test(rawUrl)) throw invalidHttp('url 不能包含控制字符');
  if (Buffer.byteLength(rawUrl, 'utf8') > HTTP_LIMITS.urlBytes) throw invalidHttp(`url 超过 ${HTTP_LIMITS.urlBytes} UTF-8 字节`);
  const method = args.method === undefined ? HTTP_DEFAULTS.method : args.method;
  if (typeof method !== 'string' || !HTTP_METHODS.includes(method)) {
    throw invalidHttp(`method 只支持 ${HTTP_METHODS.join('/')}（大小写严格匹配）`);
  }
  return {
    url: rawUrl,
    method,
    headers: validateHttpHeaders(args.headers),
    body: validateHttpBody(args.body, method),
    timeoutMs: integerInRange(args.timeoutMs, HTTP_DEFAULTS.timeoutMs, HTTP_LIMITS.timeoutMsMin, HTTP_LIMITS.timeoutMsMax, 'timeoutMs'),
    maxBytes: integerInRange(args.maxBytes, HTTP_DEFAULTS.maxBytes, HTTP_LIMITS.maxBytesMin, HTTP_LIMITS.maxBytesMax, 'maxBytes'),
    followRedirects: booleanField(args.followRedirects, HTTP_DEFAULTS.followRedirects, 'followRedirects'),
    maxRedirects: integerInRange(args.maxRedirects, HTTP_DEFAULTS.maxRedirects, 0, HTTP_LIMITS.maxRedirectsMax, 'maxRedirects'),
  };
}

/** Raw (unredacted) header record used for protocol decisions only. */
function rawHeaderMap(rawHeaders) {
  const map = new Map();
  for (let index = 0; index + 1 < rawHeaders.length; index += 2) {
    const name = String(rawHeaders[index]).toLowerCase();
    if (!map.has(name)) map.set(name, []);
    map.get(name).push(String(rawHeaders[index + 1]));
  }
  return map;
}

function rawHeaderBytes(rawHeaders) {
  let total = 0;
  for (let index = 0; index + 1 < rawHeaders.length; index += 2) {
    total += Buffer.byteLength(String(rawHeaders[index]), 'utf8') + Buffer.byteLength(String(rawHeaders[index + 1]), 'utf8') + 4;
  }
  return total;
}

function resolveHeaderUrl(value, baseUrl) {
  try { return new URL(value, baseUrl).href; } catch { return value; }
}

/** Lower-case name → non-empty string[] (duplicates preserved), sensitive values masked. */
function projectResponseHeaders(rawHeaders, baseUrl) {
  const map = new Map();
  for (let index = 0; index + 1 < rawHeaders.length; index += 2) {
    const name = String(rawHeaders[index]).toLowerCase();
    let value = String(rawHeaders[index + 1]).replace(/[\u0000-\u001f\u007f]/gu, '');
    if (HTTP_SENSITIVE_HEADERS.has(name) || HTTP_SENSITIVE_HEADER_NAME.test(name)) {
      // One masked entry per name: never leak duplicate count or value length.
      if (!map.has(name)) map.set(name, ['***']);
      continue;
    }
    if (HTTP_URL_HEADER_NAMES.has(name)) value = redactUrl(resolveHeaderUrl(value, baseUrl));
    if (!map.has(name)) map.set(name, []);
    map.get(name).push(value);
  }
  return Object.fromEntries(map);
}

function isTextualContentType(contentType) {
  if (!contentType) return false;
  const type = String(contentType).split(';')[0].trim().toLowerCase();
  if (type.startsWith('text/')) return true;
  return ['application/json', 'application/xml', 'application/javascript', 'application/x-www-form-urlencoded'].includes(type)
    || /^application\/[^;]+\+json$/u.test(type) || /^application\/[^;]+\+xml$/u.test(type);
}

function charsetAllowsUtf8(contentType) {
  const match = /charset\s*=\s*"?([^";\s]+)"?/iu.exec(String(contentType || ''));
  if (!match) return true;
  const charset = match[1].toLowerCase();
  return charset === 'utf-8' || charset === 'utf8' || charset === 'us-ascii';
}

/** utf8 only for uncompressed textual bodies with a utf-8-compatible charset and strict decode. */
function encodeHttpBody(buffer, rawMap, contentType) {
  if (buffer.length === 0) return { encoding: 'utf8', body: '' };
  const contentEncoding = (rawMap.get('content-encoding') || []).join(',').trim().toLowerCase();
  const compressed = contentEncoding !== '' && contentEncoding !== 'identity';
  if (!compressed && isTextualContentType(contentType) && charsetAllowsUtf8(contentType)) {
    try { return { encoding: 'utf8', body: new TextDecoder('utf-8', { fatal: true }).decode(buffer) }; }
    catch { /* truncated multi-byte or non-UTF-8 bytes: return the exact retained bytes */ }
  }
  return { encoding: 'base64', body: buffer.toString('base64') };
}

/** 303 (except HEAD) → GET; 301/302 only POST → GET; 307/308 keep method and body. */
function redirectMethod(status, method) {
  if (status === 303) return method === 'HEAD' ? 'HEAD' : 'GET';
  if (status === 301 || status === 302) return method === 'POST' ? 'GET' : method;
  return method;
}

function roundMs(value) {
  return Math.max(0, Math.round(Number.isFinite(value) ? value : 0));
}

export class HttpClient {
  /**
   * @param origins  () => string[] — the runtime's collected host origins (never starts Chromium)
   * @param resolve  optional DNS replacement, probe-only (mixed public/private zero-dispatch)
   */
  constructor({ origins = () => [], resolve } = {}) {
    this.origins = origins;
    this.resolve = resolve;
    this.lifecycle = new AbortController();
    this.active = new Set();
  }

  /** Plugin unload: abort every in-flight request (they settle as ABORTED) and drop handles. */
  dispose() {
    if (this.lifecycle.signal.aborted) return;
    this.lifecycle.abort();
    for (const controller of [...this.active]) {
      try { controller.abort(); } catch { /* ignore */ }
    }
    this.active.clear();
  }

  async #validateTarget(raw, signal) {
    try {
      return await validateTarget(raw, {
        origins: typeof this.origins === 'function' ? this.origins() : this.origins,
        signal,
        resolve: this.resolve,
      });
    } catch (error) {
      if (error instanceof BrowserError) throw error;
      throw httpError('HTTP_FAILED', String((error && error.message) || error), {
        phase: 'target-validation', url: redactUrl(String(raw)),
      });
    }
  }

  #send(current, method, headers, body, controller, deadline) {
    return new Promise((resolve, reject) => {
      if (performance.now() >= deadline) {
        reject(httpError('HTTP_TIMEOUT', 'HTTP 请求总超时（等待派发预算）'));
        return;
      }
      const transport = current.protocol === 'https:' ? https : http;
      let req;
      let settled = false;
      const finish = (error, value) => {
        if (settled) return;
        settled = true;
        controller.signal.removeEventListener('abort', onAbort);
        if (error) {
          try { req?.destroy(); } catch { /* ignore */ }
          reject(error);
        } else resolve(value);
      };
      const onAbort = () => {
        try { req?.destroy(); } catch { /* ignore */ }
        finish(new Error('HTTP request aborted'));
      };
      try {
        req = transport.request({
          method,
          hostname: current.hostname,
          port: current.port || undefined,
          path: current.pathname + current.search,
          headers: {
            ...headers,
            // Bytes are known exactly: avoid chunked framing for request bodies.
            ...(body === undefined ? {} : { 'content-length': String(Buffer.byteLength(body, 'utf8')) }),
            'accept-encoding': 'identity',
          },
        });
      } catch (error) {
        finish(error);
        return;
      }
      controller.signal.addEventListener('abort', onAbort, { once: true });
      req.once('upgrade', () => finish(httpError('HTTP_FAILED', '不支持协议升级响应（101）', { phase: 'headers', status: 101 })));
      req.once('response', (res) => finish(null, { req, res, headersAt: performance.now() }));
      req.once('error', (error) => finish(error));
      try {
        if (body !== undefined) req.write(Buffer.from(body, 'utf8'));
        req.end();
      } catch (error) {
        finish(error);
      }
    });
  }

  #readBody(res, maxBytes) {
    return new Promise((resolve, reject) => {
      const chunks = [];
      let bytes = 0;
      let settled = false;
      const cleanup = () => {
        res.removeListener('data', onData);
        res.removeListener('end', onEnd);
        res.removeListener('error', onError);
        res.removeListener('aborted', onAborted);
        res.removeListener('close', onClose);
      };
      const settle = (error, value) => {
        if (settled) return;
        settled = true;
        cleanup();
        if (error) reject(error); else resolve(value);
      };
      const onData = (chunk) => {
        if (settled) return;
        const room = maxBytes - bytes;
        if (chunk.length > room) {
          if (room > 0) chunks.push(chunk.subarray(0, room));
          bytes = maxBytes;
          // Stop at the byte that proves truncation: do not download the rest into memory.
          settle(null, { buffer: Buffer.concat(chunks), bytes, truncated: true });
          try { res.destroy(); } catch { /* ignore */ }
          return;
        }
        chunks.push(chunk);
        bytes += chunk.length;
      };
      const onEnd = () => settle(null, { buffer: Buffer.concat(chunks), bytes, truncated: false });
      const onError = (error) => settle(error);
      const onAborted = () => settle(new Error('response aborted before complete'));
      const onClose = () => { if (!res.complete) settle(new Error('response closed before complete')); };
      res.on('data', onData);
      res.on('end', onEnd);
      res.on('error', onError);
      res.on('aborted', onAborted);
      res.on('close', onClose);
    });
  }

  #classify(error, context) {
    const base = {
      operation: 'http-request',
      url: redactUrl(typeof context.url === 'string' ? context.url : ''),
      phase: context.phase,
      redirects: context.redirects,
      status: Number.isInteger(context.status) ? context.status : null,
    };
    if (context.termination === 'timeout') {
      return httpError('HTTP_TIMEOUT', `HTTP 请求总超时（${context.timeoutMs}ms）`, { ...base, timeoutMs: context.timeoutMs });
    }
    if (context.termination === 'aborted') return httpError('ABORTED', 'HTTP 请求已取消', base);
    if (error instanceof BrowserError) {
      error.details = { ...base, ...(error.details && typeof error.details === 'object' ? error.details : {}) };
      return error;
    }
    return httpError('HTTP_FAILED', String((error && error.message) || error), base);
  }

  async request(args, { signal, meta } = {}) {
    const params = validateHttpRequest(args);
    const initialTarget = redactUrl(params.url);
    if (meta && typeof meta === 'object') meta.target = initialTarget;
    if (this.lifecycle.signal.aborted) {
      throw httpError('ABORTED', '插件已卸载，HTTP 请求取消', { phase: 'request', url: initialTarget, redirects: [], status: null });
    }
    // Pre-aborted call: settle before any DNS lookup or dispatch.
    if (signal?.aborted) {
      throw httpError('ABORTED', 'HTTP 请求已取消', { phase: 'request', url: initialTarget, redirects: [], status: null });
    }
    const controller = new AbortController();
    this.active.add(controller);
    const startMono = performance.now();
    const deadline = startMono + params.timeoutMs;
    const redirects = [];
    let phase = 'target-validation';
    let status = null;
    let termination = null;
    let currentReq;
    let currentRes;
    const kill = () => {
      try { currentRes?.destroy(); } catch { /* ignore */ }
      try { currentReq?.destroy(); } catch { /* ignore */ }
    };
    const onKill = () => kill();
    const onCallerAbort = () => { if (!termination) termination = 'aborted'; controller.abort(); };
    const onLifecycleAbort = () => { if (!termination) termination = 'aborted'; controller.abort(); };
    const timer = setTimeout(() => { if (!termination) termination = 'timeout'; controller.abort(); }, params.timeoutMs);
    timer.unref?.();
    controller.signal.addEventListener('abort', onKill, { once: true });
    signal?.addEventListener('abort', onCallerAbort, { once: true });
    this.lifecycle.signal.addEventListener('abort', onLifecycleAbort, { once: true });
    try {
      let validated = await this.#validateTarget(params.url, controller.signal);
      if (meta && typeof meta === 'object') meta.target = redactUrl(validated);
      let current = new URL(validated);
      let method = params.method;
      let headers = { ...params.headers };
      let body = params.body;
      let redirectCount = 0;
      for (;;) {
        if (termination === 'timeout') throw httpError('HTTP_TIMEOUT', `HTTP 请求总超时（${params.timeoutMs}ms）`, { phase, url: initialTarget, redirects, status, timeoutMs: params.timeoutMs });
        if (termination === 'aborted') throw httpError('ABORTED', 'HTTP 请求已取消', { phase, url: initialTarget, redirects, status });
        if (performance.now() >= deadline) { termination = 'timeout'; throw httpError('HTTP_TIMEOUT', `HTTP 请求总超时（${params.timeoutMs}ms）`, { phase, url: initialTarget, redirects, status, timeoutMs: params.timeoutMs }); }
        phase = 'request';
        const sent = await this.#send(current, method, headers, body, controller, deadline);
        currentReq = sent.req;
        currentRes = sent.res;
        status = sent.res.statusCode;
        phase = 'headers';
        if (sent.res.statusCode === 101) {
          sent.res.destroy();
          throw httpError('HTTP_FAILED', '不支持协议升级响应（101）', { phase, url: initialTarget, redirects, status });
        }
        if (rawHeaderBytes(sent.res.rawHeaders) > HTTP_LIMITS.responseHeaderBytes) {
          sent.res.destroy();
          throw httpError('HTTP_FAILED', `响应头超过 ${HTTP_LIMITS.responseHeaderBytes} 字节`, { phase, url: initialTarget, redirects, status });
        }
        const rawMap = rawHeaderMap(sent.res.rawHeaders);
        const location = (rawMap.get('location') || [])[0];
        if (params.followRedirects && HTTP_REDIRECT_STATUS.has(sent.res.statusCode) && location) {
          phase = 'redirect';
          let next;
          try { next = new URL(location, current); }
          catch { sent.res.destroy(); throw invalidHttp('Location 不是合法 URL', { phase, url: initialTarget, redirects, status }); }
          if (current.protocol === 'https:' && next.protocol === 'http:') {
            sent.res.destroy();
            throw invalidHttp('拒绝 HTTPS→HTTP 降级重定向', { phase, url: initialTarget, redirects, status });
          }
          // Validate the next hop BEFORE any dispatch and BEFORE the budget check.
          phase = 'target-validation';
          let validatedNext;
          try { validatedNext = await this.#validateTarget(next.href, controller.signal); }
          catch (error) {
            sent.res.destroy();
            throw error;
          }
          if (redirectCount >= params.maxRedirects) {
            sent.res.destroy();
            throw httpError('HTTP_REDIRECT_LIMIT', `重定向超过预算 maxRedirects=${params.maxRedirects}`, { phase: 'redirect', url: initialTarget, redirects, status });
          }
          const nextMethod = redirectMethod(sent.res.statusCode, method);
          if (nextMethod !== method) {
            body = undefined;
            delete headers['content-type'];
          }
          if (new URL(validatedNext).origin !== current.origin) headers = {};
          redirects.push({ status: sent.res.statusCode, method, url: redactUrl(current.href), to: redactUrl(validatedNext) });
          sent.res.destroy();
          redirectCount += 1;
          current = new URL(validatedNext);
          method = nextMethod;
          continue;
        }
        phase = 'body';
        const read = await this.#readBody(sent.res, params.maxBytes);
        const projectedHeaders = projectResponseHeaders(sent.res.rawHeaders, current);
        const contentType = (projectedHeaders['content-type'] || [])[0] ?? null;
        const encoded = encodeHttpBody(read.buffer, rawMap, contentType);
        if (termination === 'timeout') throw httpError('HTTP_TIMEOUT', `HTTP 请求总超时（${params.timeoutMs}ms）`, { phase, url: initialTarget, redirects, status, timeoutMs: params.timeoutMs });
        if (termination === 'aborted') throw httpError('ABORTED', 'HTTP 请求已取消', { phase, url: initialTarget, redirects, status });
        const headersMs = roundMs(sent.headersAt - startMono);
        const totalMs = roundMs(performance.now() - startMono);
        return {
          ok: true,
          method,
          url: redactUrl(current.href),
          status: sent.res.statusCode,
          statusText: String(sent.res.statusMessage || ''),
          headers: projectedHeaders,
          contentType,
          encoding: encoded.encoding,
          body: encoded.body,
          bodyBytes: read.bytes,
          bodyTruncated: read.truncated,
          redirects,
          timings: { headersMs: Math.min(headersMs, totalMs), totalMs },
        };
      }
    } catch (error) {
      throw this.#classify(error, { termination, signal, phase, url: params.url, redirects, status, timeoutMs: params.timeoutMs });
    } finally {
      clearTimeout(timer);
      controller.signal.removeEventListener('abort', onKill);
      signal?.removeEventListener('abort', onCallerAbort);
      this.lifecycle.signal.removeEventListener('abort', onLifecycleAbort);
      try { currentRes?.destroy(); } catch { /* ignore */ }
      try { currentReq?.destroy(); } catch { /* ignore */ }
      this.active.delete(controller);
    }
  }
}

/** Register the runtime, its HTTP surface, and the agent tools. */
export function apply(ctx) {
  const log = (text) => {
    try {
      if (ctx.logger && typeof ctx.logger.info === 'function') ctx.logger.info(text);
    } catch { /* logging must never break the runtime */ }
  };
  const origins = new Set();
  const registry = new RuntimeRegistry({
    log,
    ctx,
    origins,
    maxPages: envPositiveInt('DSH_UI_TESTING_MAX_PAGES', MAX_PAGES_DEFAULT),
    idleMs: envPositiveInt('DSH_UI_TESTING_IDLE_MS', IDLE_MS_DEFAULT),
    viewerTtlMs: envPositiveInt('DSH_UI_TESTING_VIEWER_TTL_MS', VIEWER_TTL_MS),
  });
  // Independent HTTP client: shares only the collected host origins, never a page runtime.
  const httpClient = new HttpClient({ origins: () => [...origins] });
  ctx.effect(() => () => { httpClient.dispose(); }, 'ui-testing: http client');
  /**
   * P0 capture staging root: one per plugin instance, created on first non-persistent capture and
   * removed when the plugin is disposed. Screenshots default to this directory so a plain
   * `browser_screenshot` never writes into the user's workspace. A crash can leave the directory
   * behind (documented limitation); normal dispose removes it best-effort.
   */
  const captureStaging = { root: undefined };
  const ensureCaptureStagingRoot = () => {
    if (!captureStaging.root) captureStaging.root = mkdtempSync(join(tmpdir(), 'dsh-ui-testing-capture-'));
    return captureStaging.root;
  };
  ctx.effect(() => () => {
    const root = captureStaging.root;
    captureStaging.root = undefined;
    if (!root) return;
    try { rmSync(root, { recursive: true, force: true }); } catch { /* best effort */ }
  }, 'ui-testing: capture staging root');
  let attachments;
  ctx.inject(['attachments'], (sub) => {
    attachments = sub.attachments;
    sub.effect(() => () => { attachments = undefined; }, 'ui-testing: attachments');
  });
  if (typeof ctx.on === 'function') ctx.on('agent/disposed', ({ agent }) => registry.releaseSession(String(agent.id)));

  // Plugin unload waits for every page/WS/HTTP resource: the effect cleanup returns a promise.
  ctx.effect(() => () => registry.dispose(), 'ui-testing: browser runtimes');

  const connectionService = () => {
    try { return typeof ctx.get === 'function' ? ctx.get('connection') : undefined; } catch { return undefined; }
  };
  /** Historical raw-UI gate (unscoped / legacy protocol only): fail closed on any doubt. */
  const requestRejection = (req) => {
    const connection = connectionService();
    if (!connection || typeof connection.requestRejection !== 'function') return 401;
    let rejection;
    try { rejection = connection.requestRejection(req); } catch { return 401; }
    if (rejection === undefined || rejection === null || rejection === false) return 0;
    return rejection === 403 ? 403 : 401;
  };
  const uiRejection = requestRejection;

  /**
   * Strict owner-only gate for every scoped request (HTTP and WS).
   *
   * Workspace page isolation is NOT a security boundary (cookies/profile are shared), but the raw
   * UI projection (unredacted address, reload/history, frame stream) is owner-only: the request
   * must be admitted *and* its peer must be the browser's own peer. Missing connection service,
   * missing `admit`, a thrown admission or an unresolvable peer fails closed (401/503); a
   * different peer is 403. Legacy unscoped requests keep the old requestRejection-only gate.
   */
  const scopeAuthorization = (req) => {
    const connection = connectionService();
    if (!connection || typeof connection.requestRejection !== 'function') return 401;
    let rejection;
    try { rejection = connection.requestRejection(req); } catch { return 401; }
    if (rejection !== undefined && rejection !== null && rejection !== false) return rejection === 403 ? 403 : 401;
    if (typeof connection.admit !== 'function') return 503;
    let admitted;
    try { admitted = connection.admit(req); } catch { return 401; }
    if (!admitted || typeof admitted !== 'object') return 401;
    // DSH `admit()` returns `{ peer }` or `{ rejection: 401|403 }`.
    if ('rejection' in admitted) return admitted.rejection === 403 ? 403 : 401;
    const peerId = admitted.peer && admitted.peer.id;
    let browserPeer;
    try { browserPeer = connection.browserPeer; } catch { browserPeer = undefined; }
    const ownerId = browserPeer && browserPeer.id;
    if (!peerId || !ownerId) return 503;
    return peerId === ownerId ? 0 : 403;
  };
  const scopeAuthError = (res, status) => {
    const code = status === 403 ? 'SCOPE_FORBIDDEN' : status === 503 ? 'SCOPE_UNAVAILABLE' : 'UNSUPPORTED';
    const error = new BrowserError(code, status === 403 ? '该调试视图不属于当前浏览器会话' : '需要已认证且已绑定的 GUI 会话');
    sendJson(res, status, { ok: false, ...error.payload(), error: error.message });
  };
  const rejectUi = (res, status) => {
    // Authentication failures are answered inline: they are not page errors and must not be
    // written into any runtime's lastError / activity.
    const error = new BrowserError('UNSUPPORTED', '需要已认证的 GUI 会话才能访问该运行时接口');
    sendJson(res, status === 403 ? 403 : 401, { ok: false, ...error.payload(), error: error.message });
  };

  // Same-origin WebSocket push is an optimisation over the polling fallback: a failure to
  // mount it (e.g. an exotic HTTP setup) must leave the /frame polling transport working.
  ctx.effect(() => {
    let hub;
    try {
      hub = attachFramePush(ctx, {
        log,
        parseScope: parseScopeQuery,
        statusFor: scopeHttpStatus,
        // Only scoped upgrades need the strict owner-only admission; the hub keeps the legacy
        // requestRejection/loopback gate for unscoped old clients.
        authenticate: (req) => scopeAuthorization(req),
        resolve: async (scopeRequest) => {
          const resolved = await resolveScopeRequest(ctx, registry, scopeRequest);
          const entry = registry.getOrCreate(resolved);
          return { runtime: entry.runtime, scope: resolved.scope, entry };
        },
        onConnect: (runtime, entry) => {
          runtime.touchViewer();
          registry.touch(entry);
          registry.markRecent(entry);
        },
      });
    } catch (error) {
      log('ui-testing frame push unavailable: ' + String((error && error.message) || error));
      return () => {};
    }
    registry.onRetire = (runtime) => hub.release(runtime);
    return () => {
      registry.onRetire = undefined;
      hub.dispose();
    };
  }, 'ui-testing: frame push');

  // The bundled Skill is the documented, structured tool surface plus capability discovery.
  // It is optional: a deployment without the skill asset (or without the skills service) keeps
  // the browser tools working, and the failure is logged instead of aborting the plugin.
  ctx.inject(['skills'], (sub) => {
    let skill;
    try {
      skill = readBundledSkill();
    } catch (error) {
      log('ui-testing skill 未注册：' + String((error && error.message) || error));
      return;
    }
    if (!skill) {
      log('ui-testing skill 未注册：skills/ui-testing/SKILL.md 不存在');
      return;
    }
    sub.effect(() => sub.skills.register(skill), 'ui-testing: bundled skill');
  });

  /**
   * HTTP surface. Every existing path/field is unchanged; the scope headers select which
   * workspace runtime the request operates on:
   *   no scope headers            -> legacy:default (old client / old regression only)
   *   scopeVersion=1 + sessionId  -> that session's workspace (server-side cwd lookup only)
   *   scopeVersion=1 + scope      -> recent | unassigned
   *   scopeVersion=1 + binding    -> the existing runtime named by its runtimeId (owner-only)
   * Scoped requests are authenticated (strict owner-only) BEFORE any scope resolution, registry
   * creation or host-origin recording, so a rejected request has zero side effects.
   */
  const handle = async (req, res) => {
    let action = '/';
    let selected;
    try {
      const url = new URL(req.url || '/', 'http://localhost');
      action = url.pathname.slice(ROUTE_PREFIX.length) || '/';
      // Scope-header presence decides "scoped" BEFORE parsing: authentication must happen before
      // any scope resolution, registry creation, origin recording or parse-error path.
      const scopeHeaders = req.headers || {};
      const scoped = [SCOPE_HEADER_VERSION, SCOPE_HEADER_SESSION, SCOPE_HEADER_SCOPE, SCOPE_HEADER_BINDING]
        .some((name) => {
          const value = headerValue(scopeHeaders, name);
          return value !== undefined && value !== '';
        });
      if (scoped) {
        const status = scopeAuthorization(req);
        if (status) { scopeAuthError(res, status); return; }
      }
      const scopeRequest = parseHttpScope(req);
      if (req.headers?.host) {
        try { origins.add(new URL('http://' + req.headers.host).origin); } catch { /* invalid host */ }
      }
      const select = async ({ create = true } = {}) => {
        const resolved = await resolveScopeRequest(ctx, registry, scopeRequest);
        const entry = create ? registry.getOrCreate(resolved) : registry.peek(resolved.key);
        return { resolved, entry };
      };
      // Scoped callers are owner-only by construction; legacy callers keep the old fail-closed
      // requestRejection projection.
      const projected = (runtime) => (scoped || requestRejection(req) === 0 ? runtime.uiState() : runtime.state());

      if (req.method === 'GET' && action === '/frame') {
        const since = Number(url.searchParams.get('since') || 0) || 0;
        const { entry } = await select();
        selected = entry;
        const runtime = entry.runtime;
        if (runtime.running) {
          runtime.refreshMetadataSoon();
          // The 80ms poll is the only "viewer alive" signal here: refresh the view cache so a page
          // that scrolled itself is visible in `ui.observed` on a later poll (200ms throttled).
          runtime.refreshViewObservationSoon();
        }
        sendJson(res, 200, runtime.framePayload(since, projected(runtime)));
        return;
      }
      if (req.method === 'GET' && action === '/state') {
        const { entry } = await select();
        selected = entry;
        const runtime = entry.runtime;
        if (runtime.running) {
          runtime.refreshMetadataSoon();
          // Same for the 500ms GUI state poll: coalesced + ≥200ms throttled, no standing timer.
          runtime.refreshViewObservationSoon();
        }
        sendJson(res, 200, projected(runtime));
        return;
      }
      if (req.method === 'GET' && action === '/metrics') {
        const { entry } = await select();
        selected = entry;
        sendJson(res, 200, entry.runtime.metrics());
        return;
      }
      if (req.method !== 'POST') {
        const error = new BrowserError('INVALID_ARGUMENT', '只支持 GET /frame、/state、/metrics 与 POST 指令');
        sendJson(res, 405, { ok: false, ...error.payload(), error: error.message });
        return;
      }
      const body = await readJson(req);
      if (action === '/metrics') {
        const { entry } = await select();
        selected = entry;
        entry.runtime.recordClientMetrics(body);
        // Metrics is the panel's viewer heartbeat: a hidden/closed panel stops renewing and its
        // page becomes idle-collectable even if a leaked WS socket never sent a Close frame.
        entry.runtime.touchViewer();
        entry.runtime.activate();
        sendJson(res, 200, { ok: true, metrics: entry.runtime.metrics() });
        return;
      }
      if (action === '/ensure') {
        const { entry } = await select();
        selected = entry;
        registry.touch(entry);
        await entry.runtime.run(async () => {
          await entry.runtime.ensure();
          if (body.url) await entry.runtime.navigate(String(body.url));
        });
        registry.markRecent(entry);
        sendJson(res, 200, { ok: true, state: projected(entry.runtime) });
        return;
      }
      if (action === '/navigate') {
        const { entry } = await select();
        selected = entry;
        registry.touch(entry);
        await entry.runtime.run(() => entry.runtime.navigate(String(body.url || '')));
        registry.markRecent(entry);
        sendJson(res, 200, { ok: true, state: projected(entry.runtime) });
        return;
      }
      if (action === '/reload') {
        // These two routes exist only for the authenticated GUI. Scoped callers already passed
        // the strict owner-only gate above; legacy callers keep the historical check.
        if (!scoped) {
          const rejection = requestRejection(req);
          if (rejection) { rejectUi(res, rejection); return; }
        }
        const { entry } = await select();
        selected = entry;
        registry.touch(entry);
        await entry.runtime.run(() => entry.runtime.reload());
        registry.markRecent(entry);
        sendJson(res, 200, { ok: true, state: entry.runtime.uiState() });
        return;
      }
      if (action === '/history') {
        if (!scoped) {
          const rejection = requestRejection(req);
          if (rejection) { rejectUi(res, rejection); return; }
        }
        const { entry } = await select();
        selected = entry;
        registry.touch(entry);
        const moved = await entry.runtime.run(() => entry.runtime.historyMove(String(body.direction || '')));
        registry.markRecent(entry);
        sendJson(res, 200, { ok: true, moved: moved.moved, state: entry.runtime.uiState() });
        return;
      }
      if (action === '/viewport') {
        // Two shapes (docs/viewport-control.md §4.2):
        //   legacy {width,height}                 -> historical Number/round/clamp, same reply
        //   v1 {version:1, ...patch, expectedRevision?, originId?} -> strict, same validation as
        //                                            the tool; replies also carry ui.view/observed.
        const { entry } = await select();
        selected = entry;
        registry.touch(entry);
        if (body.version === undefined || body.version === null) {
          const viewport = await entry.runtime.run(async () => {
            await entry.runtime.ensure();
            return entry.runtime.applyViewport(Number(body.width), Number(body.height));
          });
          registry.markRecent(entry);
          sendJson(res, 200, {
            ok: true,
            viewport,
            // Additive projections: an old client ignores them, the new one adopts them.
            view: entry.runtime.viewProjection(),
            observed: entry.runtime.observedProjection(),
            viewMeta: entry.runtime.viewMeta(),
            requested: { width: Number(body.width), height: Number(body.height) },
            clamped: { x: false, y: false },
            applied: true,
            settled: true,
            state: projected(entry.runtime),
          });
          return;
        }
        if (body.version !== 1) {
          throw new BrowserError('INVALID_ARGUMENT', 'version 只支持 1（省略则为旧形状 {width,height}）', {
            field: 'version', valueType: typeof body.version,
          });
        }
        const originId = body.originId === undefined || body.originId === null ? null : body.originId;
        if (originId !== null && (typeof originId !== 'string' || !/^[\x20-\x7e]{1,64}$/.test(originId))) {
          throw new BrowserError('INVALID_ARGUMENT', 'originId 必须是 ≤64 个可打印 ASCII 字符（可省略）', {
            field: 'originId', valueType: typeof originId,
          });
        }
        const { version: _version, originId: _originId, ...patchFields } = body;
        const request = normalizeViewportRequest({ action: 'set', ...patchFields });
        const result = await entry.runtime.run(() => entry.runtime.applyView(expandViewPatch(request.patch), {
          source: 'gui', originId, expectedRevision: request.expectedRevision,
        }));
        registry.markRecent(entry);
        sendJson(res, 200, {
          ok: true,
          viewport: { width: result.view.width, height: result.view.height },
          view: result.view,
          observed: result.observed,
          viewMeta: result.viewMeta,
          requested: request.requested,
          clamped: result.clamped,
          applied: true,
          settled: result.settled,
          state: projected(entry.runtime),
        });
        return;
      }
      if (action === '/input') {
        const { entry } = await select();
        selected = entry;
        registry.touch(entry);
        const applied = await entry.runtime.run(() => {
          entry.runtime.touchHuman();
          return entry.runtime.input(Array.isArray(body.events) ? body.events : []);
        });
        registry.markRecent(entry);
        sendJson(res, 200, { ok: true, applied });
        return;
      }
      if (action === '/eval') {
        const { entry } = await select();
        selected = entry;
        registry.touch(entry);
        const result = await entry.runtime.run(() => entry.runtime.evaluate(String(body.expression || 'undefined')));
        registry.markRecent(entry);
        sendJson(res, 200, result.ok === false ? { ...result, ...result.error, error: result.error.message } : result);
        return;
      }
      if (action === '/screenshot') {
        const { entry } = await select();
        selected = entry;
        registry.touch(entry);
        const shot = await entry.runtime.run(() => entry.runtime.screenshot());
        registry.markRecent(entry);
        sendJson(res, 200, { ok: true, image: shot.base64, viewport: shot.viewport, capturedAt: shot.capturedAt });
        return;
      }
      if (action === '/close') {
        // Close only the selected scope. The registry entry stays (cold) so its runtimeId and
        // scope binding remain stable; the shared host exits only when no page is left.
        const { entry } = await select({ create: false });
        selected = entry;
        if (entry) {
          registry.touch(entry);
          await entry.runtime.run(() => entry.runtime.close());
        }
        sendJson(res, 200, { ok: true });
        return;
      }
      const error = new BrowserError('UNSUPPORTED', '未知指令 ' + action);
      sendJson(res, 404, { ok: false, ...error.payload(), error: error.message });
    } catch (error) {
      const classified = asBrowserError(error);
      if (selected) {
        selected.runtime.setError(classified.message, {
          actionId: null,
          target: selected.runtime.url ? redactUrl(selected.runtime.url) : null,
        });
      }
      sendJson(res, scopeHttpStatus(classified.code), { ok: false, ...classified.payload(), error: classified.message });
    }
  };

  ctx.effect(() => ctx.webServer.register({ kind: 'prefix', path: ROUTE_PREFIX, handler: handle }), 'ui-testing: http routes');

  const text = (value) => [{ type: 'text', text: typeof value === 'string' ? value : JSON.stringify(value) }];
  const register = (definition) => {
    const execute = definition.execute;
    if (!definition.timeoutMs) definition.timeoutMs = 30000;
    definition.execute = async (args, exec = {}) => {
      const sessionId = String(exec.agent?.id || 'anonymous');
      const meta = { actionId: randomUUID(), sessionId, startedAt: Date.now(), tool: definition.name,
        // Expressions and input text may contain secrets: record a bounded structural summary.
        args: Object.fromEntries(Object.entries(args || {}).map(([key, value]) => [key,
          key === 'url' ? redactUrl(String(value))
            : key === 'method' && typeof value === 'string' ? { type: 'string', value }
            : Array.isArray(value) ? { count: value.length }
            : typeof value === 'string' ? { type: 'string', length: value.length }
            : typeof value === 'number' && Number.isFinite(value) ? { type: 'number', value }
            : typeof value === 'boolean' ? { type: 'boolean', value }
            : value && typeof value === 'object' ? { type: 'object', count: Object.keys(value).length }
            : { type: typeof value }])),
      };
      const diagnostic = ['browser_state', 'browser_capabilities'].includes(definition.name);
      // Per-action read-only branch (docs/viewport-control.md §7): `browser_viewport get` is a
      // *cache* diagnostic — no ensure, no CDP (not even Page.bringToFront), no queue, no lease,
      // no recent/error bookkeeping. It may still read another owner's cached view.
      const readOnly = typeof definition.readOnly === 'function' && definition.readOnly(args) === true;
      const isHttpRequest = definition.name === 'browser_http_request';
      // Web P0 network read-only tools (session.status/reset, events, detail, trace query, evidence,
      // subscribe) are scope-local reads: they resolve the workspace runtime but never take the page
      // queue, the lease, or lazily start Chromium (docs/network-p0.md §2, R1-5).
      const isNetworkRead = definition.networkRead === true;
      // The independent HTTP tool must not enter the page queue, the lease, activity or
      // lastError; only real page/network operations participate in the error projection.
      const pageOperation = !readOnly && !diagnostic && !isHttpRequest && !isNetworkRead;
      // Resolve the workspace scope from the exec identity only (never from a client-supplied
      // path). No exec identity at all is the old protocol and maps to legacy:default.
      let entry;
      let runtime;
      try {
        const resolved = await resolveScopeRequest(ctx, registry, toolScopeRequest(exec));
        meta.scope = resolved.scope;
        // The independent HTTP tool is evidence-only: resolve identity, but never create/touch a
        // page entry (no queue, no lease, no page).
        if (!isHttpRequest) {
          entry = registry.getOrCreate(resolved);
          runtime = entry.runtime;
        }
      } catch (error) {
        if (!isHttpRequest) {
          const classified = asBrowserError(error);
          const evidence = { ...meta, finishedAt: Date.now(), target: '' };
          classified.details = losslessJson({ ...classified.details, ...evidence }, definition.name + '.details', []);
          classified.message += ' ' + JSON.stringify(evidence);
          throw classified;
        }
        // browser_http_request stays independent: workspace identity is evidence only and must
        // never gate or fail the request.
        meta.scope = { id: null, kind: 'unknown', workspaceId: null, degraded: true };
      }
      const actionTarget = definition.name === 'browser_navigate'
        ? redactUrl(String((args && args.url) || ''))
        : (runtime && runtime.url ? redactUrl(runtime.url) : null);
      // Every tool value leaves through this single lossless-JSON boundary.
      const finish = (value, target) => {
        // Envelope ordering matters per tool family (docs/network-p0.md §2):
        //  - the 7 network tools own `sessionId` (采集会话 id 或 null); the agent session moves to
        //    `agentSessionId` so the envelope can never overwrite the contract field.
        //  - the legacy 22 tools keep their historical `{...value, ...meta}` order untouched.
        const result = isNetworkRead
          ? { ...meta, ...value, agentSessionId: meta.sessionId, finishedAt: Date.now(), target }
          : { ...value, ...meta, finishedAt: Date.now(), target };
        const notes = [];
        const clean = losslessJson(result, definition.name, notes);
        if (!clean || typeof clean !== 'object' || Array.isArray(clean)) throw new BrowserError('INTERNAL', '工具返回值不是对象');
        if (notes.length > 0) clean.sanitized = notes;
        return clean;
      };
      try {
        if (isHttpRequest || isNetworkRead) {
          // Independent dispatch branch: no ensure/run/claim/touchAgent, no page queue, no
          // profile, no page lastError. The implementation does its own argument validation.
          const value = await execute(args, { ...exec, meta, sessionId, runtime, httpClient });
          return finish(value, meta.target || '');
        }
        // Optional pure pre-flight, outside the queue: an invalid argument must cost zero CDP
        // (not even the queue's Page.bringToFront) and must not touch owner/error state
        // (docs/viewport-control.md §7.1). Validation is pure: no browser, no file, no lease.
        if (typeof definition.preflight === 'function') definition.preflight(args);
        if (readOnly) {
          // Cache-only diagnostic: deliberately outside run() so it cannot activate the page,
          // wait behind the queue, claim the lease or mark the entry recent.
          meta.target = runtime.url ? redactUrl(runtime.url) : '';
          const value = await execute(args, { ...exec, meta, sessionId, runtime, httpClient });
          return finish(value, meta.target);
        }
        const value = await runtime.run(async () => {
          meta.target = runtime.url ? redactUrl(runtime.url) : '';
          if (pageOperation) runtime.touchAgent(definition.name === 'browser_navigate' ? '正在打开 ' + redactUrl(String(args?.url || '')) : ({
            browser_eval: '执行脚本', browser_input: '派发输入事件', browser_network: '读取网络记录',
            browser_viewport: '调整共享视口',
            browser_screenshot: '截图', browser_computed_style: '读取计算样式',
            browser_snapshot: '读取结构快照', browser_click: '点击元素', browser_type: '输入文本',
            browser_scroll: '滚动页面', browser_fill_form: '填写表单', browser_node_state: '读取节点状态',
            browser_wait_for: '等待节点条件',
            browser_vision_image: '视觉分析', browser_vision_find: '视觉识别定位',
            browser_vision_compare: '视觉差异比较', browser_vision_act: '按截图坐标输入',
            browser_vision_baseline: '管理视觉基线', browser_vision_check: '视觉回归检查',
          }[definition.name]));
          // GUI↔network correlation (docs/network-p0.md §3.3 / G2.5): a temporal mark before and
          // after every page tool, so event queries can associate traffic with an actionId without
          // ever claiming causality.
          runtime.netMark({ tool: definition.name, actionId: meta.actionId, kind: 'tool', text: 'begin' });
          try {
            return await execute(args, { ...exec, meta, runtime, httpClient });
          } finally {
            runtime.netMark({ tool: definition.name, actionId: meta.actionId, kind: 'tool', text: 'end' });
          }
        }, { signal: exec.signal, sessionId, agent: pageOperation,
          action: pageOperation ? { actionId: meta.actionId, target: actionTarget } : undefined });
        if (pageOperation) {
          registry.touch(entry);
          registry.markRecent(entry);
          // Any successful page operation may have moved the page (scrollIntoView, click, drag,
          // navigation, a script): refresh the view cache once, coalesced/throttled.
          // `browser_viewport set` is excluded — applyView already did its own bounded readback, and
          // a scale-only set must not cost an extra metrics read (docs/viewport-control.md §3.2).
          if (definition.name !== 'browser_viewport') runtime.refreshViewObservationSoon();
        }
        // An operation-level failure (eval/style return {ok:false,error}) is a real failure, not
        // a success that clears the projection.
        if (pageOperation && value && value.ok === false && value.error) {
          runtime.setError(value.error.message || '操作失败', { actionId: meta.actionId, target: actionTarget });
        }
        return finish(value, runtime && runtime.url ? redactUrl(runtime.url) : '');
      } catch (error) {
        const classified = asBrowserError(error);
        // Safety net: a network tool must always surface a code-bearing error with a non-empty
        // message; a bare internal error would reach the caller as `{message: ""}`.
        if (!classified.message || String(classified.message).trim() === '') {
          classified.message = `[${classified.code}] ${definition.name} 失败`;
        }
        if (!classified.code) classified.code = 'INTERNAL';
        const evidence = { ...meta, finishedAt: Date.now(), target: meta.target || (runtime && runtime.url ? redactUrl(runtime.url) : '') };
        classified.details = losslessJson({ ...classified.details, ...evidence }, definition.name + '.details', []);
        classified.message += ' ' + JSON.stringify(evidence);
        // No direct lastError write here: run() records only page/network operational failures,
        // so BUSY / argument pre-checks / pre-queue cancellation never overwrite an owner's error.
        throw classified;
      }
    };
    return ctx.effect(() => ctx.tools.register(definition), 'ui-testing: tool ' + definition.name);
  };

  register({
    name: 'browser_navigate',
    description: '在调试视图的内嵌浏览器里打开一个 HTTP(S) 地址。',
    parameters: {
      type: 'object',
      properties: { url: { type: 'string', description: '完整地址，必须带 http:// 或 https://' } },
      required: ['url'],
    },
    output: { schema: { type: 'object' }, render: (args, value) => text(value) },
    async execute(args, exec) {
      const target = String((args && args.url) || '').trim();
      return { ok: true, ...await exec.runtime.navigate(target, exec.signal) };
    },
  });

  register({
    name: 'browser_eval',
    description: '在内嵌浏览器的页面上下文里执行 JavaScript 并返回结果（T1 JS 执行能力）。',
    parameters: {
      type: 'object',
      properties: { expression: { type: 'string', description: '表达式或语句，最后一个值会被返回' } },
      required: ['expression'],
    },
    output: { schema: { type: 'object' }, render: (args, value) => text(value) },
    async execute(args, exec) {
      return exec.runtime.evaluate(String((args && args.expression) || 'undefined'), true, exec.signal);
    },
  });

  register({
    name: 'browser_screenshot',
    description: '截取内嵌浏览器的画面（PNG）：默认当前可见视口、默认比例 = 当前共享显示比例 view.scale（冷启动 100%）；可选 scale（连续 0.1–4，可用小数；重新光栅化，不是位图放大）、'
      + 'region（文档 CSS 像素的无损裁剪）、persist（默认 false：写插件暂存目录，不落工作区）、out（工作区相对 .png，提供即视为持久留存）。'
      + '只有 out / persist:true / DSH_UI_TESTING_CAPTURE_DIR 三者之一才持久落盘（0600、原子写入、绝不覆盖）；'
      + '暂存文件返回绝对路径并在插件卸载时删除。返回 PNG 结构/尺寸校验/空白识别/落盘/附件对比证据与 warnings；尺寸不符或 PNG 损坏时不交付图片。',
    parameters: {
      type: 'object',
      properties: {
        scale: {
          type: 'number',
          description: '光栅化倍数（重新光栅化，不是位图放大），连续 0.1–4，可用小数（如 0.65/1.25）。省略 = 使用共享显示比例 view.scale（默认 100% = 1），在调用内解析一次；显式值只影响本次截图，不改 view/DPR/滚动/视口。输出像素 = round(文档 CSS 尺寸 × scale)，两轴都须 ≥ 1 像素。高 DPI 只提升 DOM/CSS/文字/矢量，canvas/WebGL 内部位图不会变清晰。',
        },
        region: {
          type: 'object',
          description: '文档 CSS 像素矩形；省略 = 当前可见视口。width/height ≥ 1，期望像素上限 16,000,000。',
          properties: {
            x: { type: 'number' },
            y: { type: 'number' },
            width: { type: 'number' },
            height: { type: 'number' },
          },
          required: ['x', 'y', 'width', 'height'],
        },
        persist: {
          type: 'boolean',
          description: '是否持久留存（默认 false）。false/省略 = 写插件暂存目录（返回绝对路径，插件卸载时删除，不落工作区）；true = 持久写入可用根（DSH_UI_TESTING_CAPTURE_DIR，未配置时为工作区）下的 output/capture/<actionId>.png；根不可用则 OUTPUT_PATH_INVALID，不回落。',
        },
        out: {
          type: 'string',
          description: '工作区相对的 .png 路径（如 output/capture/demo.png）；提供即视为持久留存（等价 persist:true，但用这个文件名）。同路径不覆盖，冲突返回 OUTPUT_EXISTS（请换 out）。',
        },
      },
      required: [],
    },
    output: { schema: { type: 'object' }, render: (args, value) => {
      const { image, attachment, ...meta } = value;
      return attachment ? [{ type: 'image', attachment }, ...text(meta)] : text({ ...meta, image });
    } },
    async execute(args, exec) {
      const runtime = exec.runtime;
      // 1) Pure pre-flight: an invalid argument must cost neither a browser nor a file.
      // The network window is measured against wall-clock + the session high-water mark taken
      // *before* the capture starts (docs/network-p0.md §3.3 / R1-16); it never starts collection.
      const networkStart = { frameTimeMs: Date.now(), highWater: runtime.net ? runtime.net.seq : 0 };
      const request = normalizeCaptureRequest(args);
      // The default density is the shared `view.scale`, resolved ONCE here inside the call (cold
      // view default is 1) — an omitted scale must never be frozen to 1 by the validator
      // (docs/viewport-control.md §6.1). An explicit scale overrides it for this capture only: it
      // never writes view/DPR/scroll/viewport.
      const scale = request.scale === null ? runtime.view.scale : request.scale;
      const scaleSource = request.scale === null ? 'view' : 'explicit';
      const viewRevision = runtime.view.revision;
      const budgetRect = request.region
        || { x: 0, y: 0, width: runtime.viewport.width, height: runtime.viewport.height };
      assertCaptureBudget(budgetRect, scale);

      // 2) Persistence + output path, decided before the capture: a rejected `out` must not write a
      // PNG, and the default (no out/persist/env) must never touch the workspace.
      const envRoot = captureEnvRoot();
      const persistent = request.out !== null || request.persist === true || envRoot !== null;
      const defaultName = 'output/capture/' + exec.meta.actionId + '.png';
      let target = null;
      let rootSource = null;
      if (persistent) {
        const rootInfo = captureRootFor(exec);
        if (rootInfo.root === null) {
          throw new BrowserError('OUTPUT_PATH_INVALID', '没有可用的工作区根，无法持久落盘：请省略 out/persist 或设置 DSH_UI_TESTING_CAPTURE_DIR', {
            reason: 'root_unknown', outRequested: request.out !== null, persistRequested: request.persist,
          });
        }
        rootSource = rootInfo.source;
        const resolved = resolveCapturePath({
          root: rootInfo.root,
          out: request.out === null ? undefined : request.out,
          defaultName,
        });
        if (!resolved.ok) throw new BrowserError('OUTPUT_PATH_INVALID', resolved.message, resolved.details);
        target = resolved;
      }

      // 3) The single capture (no retry, no second encoding).
      const shot = await runtime.capture({ scale, region: request.region, scaleSource }, exec.signal);
      const data = shot.pngBytes;
      const captured = shot.capture;
      const product = await runtime.browserProduct(exec.signal);

      const warnings = [];
      const sha256 = createHash('sha256').update(data).digest('hex');
      const requestBlock = {
        scale,
        scaleSource,
        viewRevision,
        region: request.region
          ? { x: request.region.x, y: request.region.y, width: request.region.width, height: request.region.height }
          : null,
        coordinateSpace: 'document-css-px',
        out: request.out,
        persist: request.persist,
      };
      const environment = {
        browser: 'chromium',
        headless: typeof product.headless === 'boolean' ? product.headless : null,
        headlessSource: typeof product.headlessSource === 'string' ? product.headlessSource : null,
        pageDevicePixelRatio: captured.pageDevicePixelRatio === null ? null : captured.pageDevicePixelRatio,
        deviceScaleFactor: captured.deviceScaleFactor,
        deviceScaleFactorSource: captured.deviceScaleFactorSource,
        viewport: { width: captured.viewport.width, height: captured.viewport.height },
        scroll: { x: captured.scroll.x, y: captured.scroll.y },
      };

      // 4) PNG structure + CRC. Bad bytes are never delivered.
      const png = inspectPng(data, { checkCrc: true });
      if (!png.ok) {
        throw new BrowserError('INVALID_PNG', '截图返回的字节不是结构完整的 PNG（不交付坏图）', {
          phase: 'inspectPng', reason: png.message, request: requestBlock, environment,
        });
      }

      // 5) Size check against the documented formula round(css × scale × dsf).
      const expected = expectedPixelSize({
        width: captured.region.width,
        height: captured.region.height,
        scale,
        deviceScaleFactor: captured.deviceScaleFactor,
      });
      const sizeCheck = checkPixelSize({ width: png.width, height: png.height }, expected);
      const baseCapture = {
        version: 1,
        format: 'png',
        transport: 'cdp-page-capture-screenshot',
        request: requestBlock,
        environment,
        png: { width: png.width, height: png.height, bytes: data.length, chunks: png.chunks, crc: 'ok' },
        expected: {
          width: expected.width,
          height: expected.height,
          pixelsPerCssPixel: expected.pixelsPerCssPixel,
        },
      };
      if (!sizeCheck.ok) {
        // Use the module's own verdict verbatim: CAPTURE_UPSCALED only says "larger than expected"
        // (a conservative refusal), it does not prove a bitmap was upscaled.
        const message = sizeCheck.code === 'CAPTURE_UPSCALED'
          ? `截图输出尺寸超过期望（实际 ${png.width}×${png.height}，期望 ${expected.width}×${expected.height}）：保守拒绝，不交付图片`
          : `截图输出尺寸与期望不符（实际 ${png.width}×${png.height}，期望 ${expected.width}×${expected.height}）：不交付图片`;
        throw new BrowserError(sizeCheck.code, message, {
          ...baseCapture,
          sizeCheck: {
            ok: false,
            actual: sizeCheck.details.actual,
            expected: sizeCheck.details.expected,
            tolerance: sizeCheck.details.tolerance,
            reason: sizeCheck.details.reason,
          },
        });
      }

      // 6) Document-CSS mapping (projected to pure JSON: no functions in a tool value).
      const mapping = projectCaptureMapping(createCaptureMapping({
        region: captured.region,
        scroll: captured.scroll,
        viewport: captured.viewport,
        scale,
        deviceScaleFactor: captured.deviceScaleFactor,
      }));
      // Per-axis mapping from the REAL PNG size (docs/viewport-control.md §6.2): the nominal
      // `pixelsPerCssPixel` stays for old consumers, these two fields are the actual sampling.
      // Coordinates: docX = region.x + imageX * region.width / png.width (same for y).
      mapping.cssPerPixel = {
        x: captured.region.width / png.width,
        y: captured.region.height / png.height,
      };
      mapping.scrollAtCapture = { x: captured.scroll.x, y: captured.scroll.y };
      mapping.formulas.continuous = 'docX = region.x + imageX * region.width / imagePixels.width; '
        + 'viewportX = docX - scrollAtCapture.x';

      // 7) Blank check: warns only. A pure-colour page is a legal page.
      let anomaly = {
        checked: false,
        uniform: null,
        transparent: null,
        sampledPixels: 0,
        distinctColors: null,
        averageColor: null,
        maxDelta: null,
        tolerance: 0,
      };
      const decoded = decodePng(data);
      const decodedPixels = decoded.ok ? decoded.width * decoded.height : 0;
      if (decoded.ok && decodedPixels <= CAPTURE_LIMITS.maxOutputPixels) {
        const detected = detectImageAnomaly(decoded, { tolerance: 0 });
        if (detected.ok) {
          anomaly = {
            checked: true,
            uniform: detected.uniform,
            transparent: detected.transparent,
            sampledPixels: detected.sampledPixels,
            distinctColors: detected.distinctColors,
            averageColor: { ...detected.averageColor },
            maxDelta: detected.maxDelta,
            tolerance: 0,
          };
          if (detected.uniform) addCaptureWarning(warnings, 'content_uniform');
          if (detected.transparent) addCaptureWarning(warnings, 'content_transparent');
        } else {
          addCaptureWarning(warnings, 'blank_check_skipped');
        }
      } else {
        addCaptureWarning(warnings, 'blank_check_skipped');
      }

      // 8) A region entirely outside the current scroll window is legal but worth flagging.
      if (request.region && captured.viewport.width > 0 && captured.viewport.height > 0) {
        const vx = captured.scroll.x;
        const vy = captured.scroll.y;
        const outside = request.region.x + request.region.width <= vx
          || request.region.x >= vx + captured.viewport.width
          || request.region.y + request.region.height <= vy
          || request.region.y >= vy + captured.viewport.height;
        if (outside) addCaptureWarning(warnings, 'capture_beyond_viewport');
      }

      // 9) Atomic, no-clobber write of exactly the captured bytes.
      //    persistent -> workspace/env root (a write failure is a real error, never a silent pass).
      //    staging    -> the plugin instance's temporary root; a failure only drops the file, the
      //                  image is still delivered (existing warning vocabulary, no new code).
      let file = null;
      if (target) {
        const published = publishCapture(target.dir, target.absolutePath, data);
        if (!published.ok) {
          throw new BrowserError(published.code, published.message, { ...published.details, capture: baseCapture });
        }
        file = {
          path: target.relativePath,
          pathKind: 'relative',
          persistence: 'persistent',
          root: rootSource === 'env' ? 'env' : 'workspace',
          ephemeral: false,
          bytes: published.bytes,
          sha256,
          width: png.width,
          height: png.height,
          mode: published.mode,
          noClobber: true,
          createdAt: published.createdAt,
        };
      } else {
        try {
          const stagingRoot = ensureCaptureStagingRoot();
          const absolutePath = join(stagingRoot, exec.meta.actionId + '.png');
          const published = publishCapture(stagingRoot, absolutePath, data);
          if (!published.ok) throw new Error('staging publish failed: ' + published.code);
          file = {
            path: absolutePath,
            pathKind: 'absolute',
            persistence: 'staging',
            root: 'staging',
            ephemeral: true,
            bytes: published.bytes,
            sha256,
            width: png.width,
            height: png.height,
            mode: published.mode,
            noClobber: true,
            createdAt: published.createdAt,
          };
        } catch {
          // Staging is delivery evidence only: never fail the capture because tmp is unusable.
          addCaptureWarning(warnings, 'capture_file_unavailable');
        }
      }

      // 10) Attachment comparison: what the model receives vs the original capture.
      const delivery = {
        original: { width: png.width, height: png.height, bytes: data.length, sha256, mediaType: 'image/png' },
        image: null,
        downscaled: false,
        reencoded: false,
      };
      let attachment;
      let attachmentError;
      let imageDelivery = 'base64-fallback';
      if (typeof attachments?.saveImage === 'function') {
        try {
          attachment = projectAttachment(await abortable(
            attachments.saveImage({ data, mediaType: 'image/png', name: `ui-testing-${exec.meta.actionId}.png` }),
            exec.signal,
          ));
        } catch (error) {
          if (error.code === 'ABORTED') throw error;
          attachmentError = '附件保存失败，使用 base64-fallback';
        }
        if (attachment) {
          imageDelivery = 'attachment';
          const refWidth = Number.isFinite(attachment.width) ? attachment.width : null;
          const refHeight = Number.isFinite(attachment.height) ? attachment.height : null;
          const refBytes = Number.isFinite(attachment.bytes) ? attachment.bytes : null;
          const refMediaType = typeof attachment.mediaType === 'string' ? attachment.mediaType : null;
          delivery.image = { width: refWidth, height: refHeight, bytes: refBytes, mediaType: refMediaType };
          if ((refWidth !== null && refWidth < png.width) || (refHeight !== null && refHeight < png.height)) {
            delivery.downscaled = true;
            addCaptureWarning(warnings, 'model_image_downscaled');
          }
          // A normalized/re-encoded attachment no longer carries this capture's bytes: say so
          // instead of implying the model saw the file verbatim.
          if ((refMediaType !== null && refMediaType !== 'image/png')
            || (refBytes !== null && refBytes !== data.length)
            || (typeof attachment.sha256 === 'string' && attachment.sha256 !== sha256)) {
            delivery.reencoded = true;
            addCaptureWarning(warnings, 'attachment_reencoded');
          }
        }
      } else {
        addCaptureWarning(warnings, 'attachment_unavailable');
      }

      // 11) Lightweight facts for browser_capabilities.capture.observed (relative paths only).
      runtime.captureObservation = {
        observedAt: captured.capturedAt,
        scale,
        scaleSource,
        png: { width: png.width, height: png.height },
        sizeCheck: { ok: true },
        anomaly: { checked: anomaly.checked, uniform: anomaly.uniform, transparent: anomaly.transparent },
        delivery: { downscaled: delivery.downscaled },
        // No absolute path ever reaches capabilities: staging files are simply not addressable
        // from the observation, persistent ones keep their workspace-relative path.
        file: file
          ? { persistence: file.persistence, relativePath: file.pathKind === 'relative' ? file.path : null }
          : null,
      };

      const networkWindow = runtime.net
        ? runtime.net.window({ frameTimeMs: networkStart.frameTimeMs, captureEndMs: Date.now(), highWater: networkStart.highWater })
        : { sessionId: null, fromSeq: null, toSeq: null, frameTimeMs: networkStart.frameTimeMs, captureEndMs: Date.now(), nearest: null, count: 0 };
      return {
        // Historical field kept verbatim: the CSS viewport actually captured (P7/P16 assert it).
        viewport: { width: captured.viewport.width, height: captured.viewport.height },
        // Top-level alias of `capture.networkWindow` (same object; additive only).
        networkWindow,
        bytes: data.length,
        image: shot.base64,
        capturedAt: captured.capturedAt,
        sha256,
        attachment,
        attachmentId: attachment ? (attachment.attachmentId || attachment.id) : null,
        imageDelivery,
        attachmentError,
        capture: {
          ...baseCapture,
          sizeCheck: {
            ok: true,
            actual: { width: png.width, height: png.height },
            expected: { width: expected.width, height: expected.height },
            upscaled: false,
          },
          mapping,
          anomaly,
          file,
          delivery,
          warnings,
          // Additive only: capture.version stays 1 and every existing field is untouched.
          networkWindow,
        },
      };
    },
  });

  register({
    name: 'browser_input',
    description: '向内嵌浏览器派发鼠标 / 滚轮 / 键盘事件（T1 原生事件能力）。坐标使用页面 CSS 像素。'
      + '修饰键用 modifiers（字符串数组 alt/ctrl/meta/shift，或 CDP 位掩码整数 Alt=1/Ctrl=2/Meta=4/Shift=8）。',
    parameters: {
      type: 'object',
      properties: {
        events: {
          type: 'array',
          items: {
            type: 'object',
            properties: {
              kind: { type: 'string', enum: ['mouse', 'wheel', 'key', 'text'] },
              type: { type: 'string', description: 'mouse: mousePressed/mouseReleased/mouseMoved；key: keyDown/keyUp/rawKeyDown/char' },
              x: { type: 'number' },
              y: { type: 'number' },
              button: { type: 'string', description: '鼠标键：left/right/middle/back/forward/none' },
              buttons: { type: 'number', description: '按下的鼠标键位掩码（CDP buttons），移动/拖拽时需带上' },
              pointerType: { type: 'string', enum: ['mouse', 'pen'] },
              clickCount: { type: 'number' },
              deltaX: { type: 'number' },
              deltaY: { type: 'number' },
              modifiers: {
                description: '修饰键：字符串数组 alt/ctrl/meta/shift，或 CDP 位掩码整数（Alt=1,Ctrl=2,Meta=4,Shift=8）。key/mouse/wheel 都支持。',
                // Host-supported JSON-schema subset only (no minimum/maximum): the 0–15 range
                // is enforced at execution time in normalizeModifiers().
                oneOf: [
                  { type: 'array', items: { type: 'string', enum: ['alt', 'ctrl', 'meta', 'shift'] } },
                  { type: 'integer' },
                ],
              },
              key: { type: 'string', description: '键名或字符，如 a / Tab / Enter / Escape' },
              code: { type: 'string', description: '物理键位，如 KeyA / Tab / Enter' },
              text: { type: 'string', description: 'key: 随按键产生的文本（char 类型必需）；text kind: 直接插入的文本' },
              unmodifiedText: { type: 'string', description: '未受修饰键影响的文本（CDP unmodifiedText）' },
              virtualKeyCode: { type: 'number', description: 'CDP windowsVirtualKeyCode，决定页面 e.keyCode；如 Tab=9、Enter=13、Escape=27、A=65' },
              autoRepeat: { type: 'boolean', description: '是否为按键重复（页面 e.repeat）' },
              commands: { type: 'array', items: { type: 'string' }, description: 'CDP commands，如 ["selectAll"]（仅部分平台生效）' },
              location: { type: 'number', description: '键位：0 标准、1 左、2 右、3 数字键盘（页面 e.location）' },
              isKeypad: { type: 'boolean', description: '是否数字键盘按键' },
            },
            required: ['kind'],
          },
        },
      },
      required: ['events'],
    },
    output: { schema: { type: 'object' }, render: (args, value) => text(value) },
    async execute(args, exec) {
      const applied = await exec.runtime.input(args?.events, exec.signal);
      return { ok: true, applied };
    },
  });

  register({
    name: 'browser_network',
    description: '读取内嵌浏览器最近捕获的网络请求（T1 网络抓包，默认不含请求体）。',
    parameters: {
      type: 'object',
      properties: { limit: { type: 'number', description: '最多返回条数，默认 50' } },
      required: [],
    },
    output: { schema: { type: 'object' }, render: (args, value) => text(value) },
    async execute(args, exec) {
      return exec.runtime.traffic(Number(args && args.limit) || 50);
    },
  });

  // ---- Web P0 network surface (docs/network-p0.md §2): 7 tools, 22 → 29. ---------------------
  // Every one of them is `networkRead`: the read-only actions must resolve the workspace scope but
  // never start Chromium or take the page lease. `session.start` and the page-requiring `control`
  // actions call `runtime.run()` themselves, so BUSY/ABORTED/CDP_* keep their platform semantics.
  register({
    networkRead: true,
    name: 'browser_network_session',
    description: '启停/查询网络采集会话（WEB-P0）：start 是唯一的网络懒启动动作，stop 幂等，status/reset 只读不启动浏览器。'
      + 'config 支持 captureBodies/captureWebSocket/captureSse/captureWorkers/maxEvents(≤20000)/maxBodyBytes(≤1MiB)/maxTotalBytes(≤32MiB)/maxWsFrames(≤20000)/businessStatusPath/maskRules。',
    parameters: {
      type: 'object',
      additionalProperties: false,
      required: ['action'],
      properties: {
        action: { type: 'string', enum: ['start', 'stop', 'status', 'reset'], description: 'start|stop|status|reset' },
        name: { type: 'string', description: '会话名，≤64 字节，默认 default；同名 start 幂等' },
        config: { type: 'object', description: '仅 start 生效；未知字段与越界配额会被拒绝' },
      },
    },
    output: { schema: { type: 'object' }, render: (args, value) => text(value) },
    async execute(args, exec) {
      return exec.runtime.netSession(args || {}, exec, exec.signal);
    },
  });

  register({
    networkRead: true,
    name: 'browser_network_events',
    description: '读取/筛选/检索/聚合网络事件（只读，不启动浏览器）：view=summary|full|timeline|aggregate，filter 支持 method/status/statusClass/resourceType/urlIncludes/failed/kind/phase/stepId/时间/耗时，search 命中只回脱敏预览。',
    parameters: {
      type: 'object',
      additionalProperties: false,
      required: [],
      properties: {
        sessionId: { type: 'string' },
        sinceSeq: { type: 'integer' },
        untilSeq: { type: 'integer' },
        cursor: { type: 'string' },
        limit: { type: 'integer', default: 50, description: '1–200，默认 50' },
        order: { type: 'string', enum: ['asc', 'desc'] },
        view: { type: 'string', enum: ['summary', 'full', 'timeline', 'aggregate'] },
        filter: { type: 'object' },
        search: { type: 'object' },
        groupBy: { type: 'string', enum: ['url', 'method', 'status', 'statusClass', 'resourceType', 'host', 'kind', 'step'] },
        aggregate: { type: 'array', items: { type: 'string' } },
      },
    },
    output: { schema: { type: 'object' }, render: (args, value) => text(value) },
    async execute(args, exec) {
      return exec.runtime.netEvents(args || {});
    },
  });

  register({
    networkRead: true,
    name: 'browser_network_detail',
    description: '按 requestId（同一 target 内）或 seq 读取一条请求/WS/SSE 的完整详情；纯只读，不启动 CDP、不补读 body。'
      + 'body 三态 captured|empty|unavailable，读不到即 available:false + NET_BODY_UNAVAILABLE，绝不伪造空体。',
    parameters: {
      type: 'object',
      additionalProperties: false,
      required: [],
      properties: {
        sessionId: { type: 'string' },
        requestId: { type: 'string' },
        seq: { type: 'integer' },
        hopId: { type: 'integer', description: '重定向跳数（内部键的一部分），跨 target 同 requestId 时配合 seq 使用' },
        targetId: { type: 'string' },
        include: { type: 'array', items: { type: 'string' } },
        maxBodyBytes: { type: 'integer', description: '1024–1048576，默认 1048576' },
      },
    },
    output: { schema: { type: 'object' }, render: (args, value) => text(value) },
    async execute(args, exec) {
      return exec.runtime.netDetail(args || {});
    },
  });

  register({
    networkRead: true,
    name: 'browser_network_trace',
    description: '业务链路追踪：begin-step/end-step 开窗、mark 打标记、link 显式关联、window 查窗口、query 汇总（只读不启动浏览器）。'
      + '对象提取只按显式 objectRules；因果 basis 仅 explicit|redirect|initiator，temporal 需 includeTemporal:true 且不冒充因果。',
    parameters: {
      type: 'object',
      additionalProperties: false,
      required: ['action'],
      properties: {
        sessionId: { type: 'string' },
        action: { type: 'string', enum: ['begin-step', 'end-step', 'mark', 'link', 'window', 'query', 'reset'] },
        stepId: { type: 'string' },
        name: { type: 'string' },
        labels: { type: 'object' },
        window: { type: 'object' },
        objectRules: { type: 'array', items: { type: 'object' } },
        correlationRules: { type: 'array', items: { type: 'object' } },
        businessStatusPath: { type: 'string' },
        mark: { type: 'object' },
        link: { type: 'object' },
        query: { type: 'object' },
        includeTemporal: { type: 'boolean', default: false },
      },
    },
    output: { schema: { type: 'object' }, render: (args, value) => text(value) },
    async execute(args, exec) {
      return exec.runtime.netTrace(args || {});
    },
  });

  register({
    networkRead: true,
    name: 'browser_network_control',
    description: '拦截/改写/限速/断连/重放/Mock（需要 page 的动作自行懒启动）：throttle/offline 组合状态下发、intercept-add/remove/clear/list、'
      + 'hold/resume、replay(via page|http)、mock、reset。reset 不停会话、不 Fetch.disable（导航守卫保持启用）。',
    parameters: {
      type: 'object',
      additionalProperties: false,
      required: ['action'],
      properties: {
        sessionId: { type: 'string' },
        action: {
          type: 'string',
          enum: ['throttle', 'offline', 'intercept-add', 'intercept-remove', 'intercept-clear', 'intercept-list', 'hold', 'resume', 'replay', 'mock', 'reset'],
        },
        throttle: { type: 'object' },
        offline: { type: 'boolean' },
        rule: { type: 'object' },
        ruleId: { type: 'string' },
        requestId: { type: 'string' },
        seq: { type: 'integer' },
        then: { type: 'object' },
        replay: { type: 'object' },
        mock: { type: 'object' },
        confirm: { type: 'boolean' },
      },
    },
    output: { schema: { type: 'object' }, render: (args, value) => text(value) },
    async execute(args, exec) {
      return exec.runtime.netControl(args || {}, exec, exec.signal);
    },
  });

  register({
    networkRead: true,
    name: 'browser_network_evidence',
    description: '网络证据 JSONL/HAR 导入导出、索引、检索、链接与完整性（不启动浏览器）。'
      + 'export 只写持久根（env 或工作区 cwd）内的相对路径，只回相对路径；无持久根报 NET_OUTPUT_ROOT_UNKNOWN，绝不写暂存目录或回绝对路径。',
    parameters: {
      type: 'object',
      additionalProperties: false,
      required: ['action'],
      properties: {
        sessionId: { type: 'string' },
        action: { type: 'string', enum: ['export', 'import', 'index', 'search', 'link', 'integrity', 'clear', 'list'] },
        format: { type: 'string', enum: ['jsonl', 'har', 'auto'] },
        out: { type: 'string', description: '持久根内相对路径（.jsonl/.har）' },
        persist: { type: 'boolean' },
        includeBodies: { type: 'boolean' },
        file: { type: 'string', description: 'import：持久根内相对路径' },
        data: { type: 'string', description: 'import：内联文本 ≤8 MiB（与 file 二选一）' },
        query: { type: 'object' },
        link: { type: 'object' },
        deleteFiles: { type: 'boolean' },
      },
    },
    output: { schema: { type: 'object' }, render: (args, value) => text(value) },
    async execute(args, exec) {
      return exec.runtime.netEvidence(args || {}, exec);
    },
  });

  register({
    networkRead: true,
    name: 'browser_network_subscribe',
    description: '同一 scope 内多 Agent 共享采集、各自独立订阅游标（owner-only）：create/poll/ack/close/list。'
      + 'ack 前不丢受 subscriptionPin 硬上限约束，超出给 gap/dropped；他人订阅 NET_SUBSCRIPTION_FORBIDDEN。',
    parameters: {
      type: 'object',
      additionalProperties: false,
      required: ['action'],
      properties: {
        sessionId: { type: 'string' },
        action: { type: 'string', enum: ['create', 'poll', 'ack', 'close', 'list'] },
        subscriptionId: { type: 'string' },
        cursor: { type: 'string' },
        afterSeq: { type: 'integer' },
        limit: { type: 'integer', description: '1–200' },
        kinds: { type: 'array', items: { type: 'string' } },
        ackSeq: { type: 'integer' },
      },
    },
    output: { schema: { type: 'object' }, render: (args, value) => text(value) },
    async execute(args, exec) {
      return exec.runtime.netSubscribe(args || {}, exec.meta.sessionId);
    },
  });

  register({
    name: 'browser_computed_style',
    description: '读取内嵌浏览器里某个元素的计算样式（T1 CSSOM 能力）。',
    parameters: {
      type: 'object',
      properties: {
        selector: { type: 'string' },
        properties: { type: 'array', items: { type: 'string' } },
      },
      required: ['selector'],
    },
    output: { schema: { type: 'object' }, render: (args, value) => text(value) },
    async execute(args, exec) {
      return exec.runtime.computedStyle(String(args && args.selector), Array.isArray(args && args.properties) ? args.properties : undefined, exec.signal);
    },
  });

  register({
    name: 'browser_http_request',
    description: '用独立的 HTTP(S) 客户端直接请求接口（不启动 Chromium、不占用页面租约、无 Cookie jar）：'
      + 'ok:true 只表示取得响应，不代表 2xx；默认 GET/5s/64KiB、默认不跟随重定向；响应体按字节上限截断并标记 truncated。',
    parameters: {
      type: 'object',
      additionalProperties: false,
      required: ['url'],
      properties: {
        method: {
          type: 'string',
          enum: ['GET', 'HEAD', 'POST', 'PUT', 'PATCH', 'DELETE', 'OPTIONS'],
          default: 'GET',
          description: 'HTTP 方法，大小写严格匹配；默认 GET',
        },
        url: { type: 'string', description: '绝对 HTTP(S) URL；不 trim；UTF-8 ≤ 8192 字节（执行时校验）' },
        headers: { type: 'object', description: '调用方请求头：单值字符串；≤64 条、键 ≤128 字符、单值 ≤4096 字节、合计 ≤8192 字节、重名与危险头在执行时校验' },
        body: { type: 'string', description: 'UTF-8 请求体，≤65536 字节（执行时校验）；GET/HEAD 提供即拒绝；不自动设置 content-type' },
        timeoutMs: { type: 'integer', default: 5000, description: '总截止时间毫秒（覆盖 DNS/连接/每跳/头/正文）；范围 1–20000（执行时校验）' },
        maxBytes: { type: 'integer', default: 65536, description: '响应保留字节上限；范围 1–1048576（执行时校验）' },
        followRedirects: { type: 'boolean', default: false, description: '是否手动跟随重定向；默认不跟随' },
        maxRedirects: { type: 'integer', default: 0, description: '最多再派发跳数；范围 0–5（执行时校验）；followRedirects=false 时不生效' },
      },
    },
    output: { schema: { type: 'object' }, render: (args, value) => text(value) },
    async execute(args, exec) {
      return httpClient.request(args, { signal: exec.signal, meta: exec.meta });
    },
  });

  // Web T2 tool surface (16 tools total). Every one of these is a page operation: lazy start, the
  // serial page queue and the single-owner lease all apply. Targets are the two mutually exclusive
  // plain strings `ref` / `selector`; `ref` comes from browser_snapshot and never carries a
  // snapshotId — the Runtime keeps that provenance internally.
  register({
    name: 'browser_snapshot',
    description: '读取页面的结构化快照（无障碍树 + 可交互元素 ref）：先 snapshot 拿 ref=e1/e2…，再用 click/type/scroll/fill_form/node_state/wait_for 操作。'
      + 'ref 编号在本次运行内单调增长、永不复用；主框架跨文档导航/刷新/历史前进后退、主执行上下文丢失与关闭会使 ref 失效（REF_STALE）。',
    parameters: {
      type: 'object',
      properties: {
        scope: {
          type: 'object',
          description: '只在某个 ref 或唯一 selector 的子树内建快照（默认整个主文档）；两者恰给一个',
          properties: {
            ref: { type: 'string', description: '快照里的 ref（eN）' },
            selector: { type: 'string', description: '主文档内唯一命中的 CSS 选择器' },
          },
          required: [],
        },
        maxNodes: { type: 'integer', description: `最多输出的语义节点数，默认 ${T2_LIMITS.snapshotDefaultMaxNodes}，上限 ${T2_LIMITS.snapshotMaxNodes}` },
        depth: { type: 'integer', description: `最大深度，默认 ${T2_LIMITS.snapshotDefaultDepth}；0 表示只输出根节点，上限 ${T2_LIMITS.snapshotMaxDepth}` },
        boxes: { type: 'boolean', description: '是否在行尾追加 [box=x,y,width,height] 并回填 refs.bbox（默认 false）' },
      },
      required: [],
    },
    output: { schema: { type: 'object' }, render: (args, value) => text(value) },
    async execute(args, exec) {
      return exec.runtime.snapshot(args || {}, exec.signal);
    },
  });

  register({
    name: 'browser_click',
    description: '点击快照里的元素（ref 或唯一 selector）：滚动进视口、两次动画帧确认稳定、命中校验通过后用 CDP 真实鼠标事件派发（不是页面内 .click()）。'
      + 'hidden/disabled/inert/零面积/离屏/被遮挡/持续运动都零派发失败（NOT_INTERACTABLE，details.reason 说明原因；hidden/covered 带 escalation:T3）。',
    parameters: {
      type: 'object',
      properties: {
        ref: { type: 'string', description: '快照里的 ref（eN）' },
        selector: { type: 'string', description: '主文档内唯一命中的 CSS 选择器' },
        button: { type: 'string', description: '鼠标键：left/right/middle，默认 left' },
        clickCount: { type: 'integer', description: '1 或 2（2 = 双击：两组 press/release，clickCount 依次 1、2），默认 1' },
        modifiers: { type: 'array', items: { type: 'string' }, description: '修饰键 alt/ctrl/meta/shift（不重复，最多 4 项）' },
      },
      required: [],
    },
    output: { schema: { type: 'object' }, render: (args, value) => text(value) },
    async execute(args, exec) {
      return exec.runtime.click(args || {}, exec.signal);
    },
  });

  register({
    name: 'browser_type',
    description: '向快照里的原生输入框输入文本：可信点击定位焦点并用深层 activeElement 校验，replace:true（默认）先 Ctrl+A + Backspace 再 Input.insertText，replace:false 追加到末尾；'
      + 'submit:true 在值校验通过后派发 Enter。仅支持 input text/search/email/url/tel/password 与 textarea，其它控件抛 UNSUPPORTED。结果不回显输入原文。',
    parameters: {
      type: 'object',
      properties: {
        ref: { type: 'string', description: '快照里的 ref（eN）' },
        selector: { type: 'string', description: '主文档内唯一命中的 CSS 选择器' },
        text: { type: 'string', description: '要输入的文本（允许空串 = 清空，≤65536 UTF-8 字节）' },
        replace: { type: 'boolean', description: '是否替换已有内容，默认 true' },
        submit: { type: 'boolean', description: '输入后派发 Enter，默认 false' },
      },
      required: ['text'],
    },
    output: { schema: { type: 'object' }, render: (args, value) => text(value) },
    async execute(args, exec) {
      return exec.runtime.typeText(args || {}, exec.signal);
    },
  });

  register({
    name: 'browser_scroll',
    description: '滚动：默认操作 document.scrollingElement，给 ref/selector 时滚动该元素自身的滚动区。direction 与 to 必给且只给一个：'
      + 'direction 派发 CDP mouseWheel 后最多观察 1000ms 至坐标稳定；to=top|bottom 用 scrollTo 精确定位（eventSource=dom-scroll，不接受 amount）。到边界 moved=false 仍是成功。',
    parameters: {
      type: 'object',
      properties: {
        ref: { type: 'string', description: '滚动容器（快照 ref）；省略则滚动文档' },
        selector: { type: 'string', description: '滚动容器（唯一 CSS 选择器）' },
        direction: { type: 'string', description: 'up/down/left/right（与 to 二选一）' },
        amount: { type: 'integer', description: `滚动量（CSS 像素），默认 ${T2_LIMITS.scrollAmount}，1–${T2_LIMITS.scrollMaxAmount}` },
        to: { type: 'string', description: 'top/bottom：精确滚到端点；与 direction 二选一，且不接受 amount' },
      },
      required: [],
    },
    output: { schema: { type: 'object' }, render: (args, value) => text(value) },
    async execute(args, exec) {
      return exec.runtime.scroll(args || {}, exec.signal);
    },
  });

  register({
    name: 'browser_fill_form',
    description: '按顺序填写多个原生控件（textbox/checkbox/radio/combobox/slider）：整批先校验参数、解析全部目标、检查控件类型/选项/取值范围与重复目标，全部通过才逐项执行。'
      + 'textbox/checkbox/radio 用可信 CDP 输入；combobox/slider 用原生 setter（eventSource=dom-control，不打开原生下拉、不模拟拖动）。'
      + '失败停止不回滚：details 带 applied/failedIndex/fields。',
    parameters: {
      type: 'object',
      properties: {
        fields: {
          type: 'array',
          items: {
            type: 'object',
            properties: {
              ref: { type: 'string', description: '快照里的 ref（eN）' },
              selector: { type: 'string', description: '主文档内唯一命中的 CSS 选择器' },
              type: { type: 'string', description: 'textbox/checkbox/radio/combobox/slider' },
              value: { description: 'textbox: 字符串；checkbox/radio: 布尔（radio 只接受 true）；combobox: 字符串或字符串数组；slider: 有限数字' },
            },
            required: ['type', 'value'],
          },
        },
      },
      required: ['fields'],
    },
    output: { schema: { type: 'object' }, render: (args, value) => text(value) },
    async execute(args, exec) {
      return exec.runtime.fillForm(args || {}, exec.signal);
    },
  });

  register({
    name: 'browser_node_state',
    description: '读取单个节点的完整当前状态（ref 或唯一 selector）：role/name/可见/启用/只读/勾选/展开/焦点/bbox/hitTarget/滚动等，现场读取而不复用快照。'
      + 'hidden/disabled/readonly/被遮挡的节点也能成功读取；可编辑控件的 value 默认脱敏为 null（valueRedacted:true）。',
    parameters: {
      type: 'object',
      properties: {
        ref: { type: 'string', description: '快照里的 ref（eN）' },
        selector: { type: 'string', description: '主文档内唯一命中的 CSS 选择器' },
      },
      required: [],
    },
    output: { schema: { type: 'object' }, render: (args, value) => text(value) },
    async execute(args, exec) {
      return exec.runtime.nodeState(args || {}, exec.signal);
    },
  });

  register({
    name: 'browser_wait_for',
    description: '在同一个页面队列内轮询等待：text/textGone（主文档 body.innerText 包含/不包含）或 ref/selector + state{visible,enabled,checked,valueEquals}（AND，省略 state 等价 visible:true）。三类条件互斥。'
      + '超时抛 WAIT_TIMEOUT（details 含 elapsedMs/polls/condition/最后观察），页面不关闭；ref 失效立即 REF_STALE。',
    parameters: {
      type: 'object',
      properties: {
        text: { type: 'string', description: '等待正文包含该子串（≤4096 字节）' },
        textGone: { type: 'string', description: '等待正文不再包含该子串（≤4096 字节）' },
        ref: { type: 'string', description: '等待目标（快照 ref）' },
        selector: { type: 'string', description: '等待目标（唯一 CSS 选择器；0 命中时 visible:false 可满足）' },
        state: {
          type: 'object',
          description: '目标状态条件（需同时给 ref 或 selector）',
          properties: {
            visible: { type: 'boolean' },
            enabled: { type: 'boolean' },
            checked: { type: 'boolean' },
            valueEquals: { type: 'string' },
          },
          required: [],
        },
        timeoutMs: { type: 'integer', description: `超时预算毫秒，默认 ${T2_LIMITS.waitDefaultTimeoutMs}，0 表示只采样一次，上限 ${T2_LIMITS.waitMaxTimeoutMs}` },
        pollMs: { type: 'integer', description: `轮询间隔毫秒，默认 ${T2_LIMITS.waitDefaultPollMs}（${T2_LIMITS.waitMinPollMs}–${T2_LIMITS.waitMaxPollMs}）` },
      },
      required: [],
    },
    // A 30000ms condition budget must be able to report WAIT_TIMEOUT before the host kills the
    // call, so this tool alone gets a larger envelope timeout (contract §4.4).
    timeoutMs: 35000,
    output: { schema: { type: 'object' }, render: (args, value) => text(value) },
    async execute(args, exec) {
      return exec.runtime.waitFor(args || {}, exec.signal);
    },
  });

  register({
    name: 'browser_viewport',
    // `get` is a cache diagnostic only: the wrapper must not ensure/queue/lease/activate for it.
    readOnly: (args) => Boolean(args) && typeof args === 'object' && args.action === 'get',
    // Pure pre-flight outside the queue: a rejected patch costs no CDP and no page change.
    preflight: (args) => { normalizeViewportRequest(args); },
    description: '共享视口（T1）：get=只读缓存诊断（不启动浏览器、不发 CDP、不占租约；可读取他人租约下的缓存，stale 明示）；'
      + 'set=页面操作（懒启动 + 串行队列 + single-owner-lease，仅改比例也算页面操作）。坐标是文档 CSS 像素的页面顶层滚动位置（x/y），'
      + '不是窗口位置；宽高显式修改页面 CSS 视口，仅改比例不改视口/DPR/页面缩放。'
      + 'mode 预设 wide/landscape/tablet/phone；expectedRevision 冲突返回 VIEWPORT_CONFLICT（本次 patch 零应用）。',
    parameters: {
      type: 'object',
      additionalProperties: false,
      required: ['action'],
      properties: {
        action: { type: 'string', enum: ['get', 'set'], description: 'get=只读缓存诊断（不接受其他字段）；set=应用一个 patch（至少一个 view 字段）' },
        mode: {
          type: 'string',
          enum: ['wide', 'landscape', 'tablet', 'phone'],
          description: '预设：wide 1920×1080 / landscape 1024×768 / tablet 768×1024 / phone 393×852；与 width/height 互斥。custom 只作为派生返回值。',
        },
        x: { type: 'number', description: `页面顶层滚动位置 X（文档 CSS px，${VIEW_LIMITS.scroll[0]}–${VIEW_LIMITS.scroll[1]}）；成功后回读实际值（可能被 clamp）` },
        y: { type: 'number', description: `页面顶层滚动位置 Y（文档 CSS px，${VIEW_LIMITS.scroll[0]}–${VIEW_LIMITS.scroll[1]}）；成功后回读实际值（可能被 clamp）` },
        width: { type: 'integer', description: `CSS 视口宽（整数 ${VIEW_LIMITS.width[0]}–${VIEW_LIMITS.width[1]}）；只有宽高变化才发送 Emulation.setDeviceMetricsOverride` },
        height: { type: 'integer', description: `CSS 视口高（整数 ${VIEW_LIMITS.height[0]}–${VIEW_LIMITS.height[1]}）` },
        scale: {
          type: 'number',
          description: `共享显示比例 ${VIEW_LIMITS.scale[0]}–${VIEW_LIMITS.scale[1]}（即 ${VIEW_LIMITS.scale[0] * 100}–${VIEW_LIMITS.scale[1] * 100}%，1=100%）；`
            + '也是省略 scale 的 browser_screenshot 默认比例。不是 DPR、不是页面缩放、不做设备模拟（dsf 固定 1）。',
        },
        expectedRevision: { type: 'integer', description: '可选 CAS：与队列内当前 view.revision 不同则 VIEWPORT_CONFLICT（不应用 patch，返回 latest view）' },
      },
    },
    output: { schema: { type: 'object' }, render: (args, value) => text(value) },
    async execute(args, exec) {
      const request = normalizeViewportRequest(args);
      if (request.action === 'get') {
        // Cache-only: the wrapper already bypasses run()/ensure()/lease for this action.
        return exec.runtime.viewSnapshot();
      }
      const result = await exec.runtime.applyView(expandViewPatch(request.patch), {
        signal: exec.signal,
        source: 'agent',
        originId: null,
        expectedRevision: request.expectedRevision,
      });
      return { ok: true, ...result, requested: { ...request.requested } };
    },
  });

  register({
    name: 'browser_state',
    description: '读取内嵌浏览器的当前状态：地址、标题、视口（旧 {width,height} 与安全 view 投影）、控制权归属。'
      + '不保证新鲜：需要确定更新后事实请用 browser_viewport set 的读回，或 browser_viewport get 的缓存诊断。',
    parameters: { type: 'object', properties: {}, required: [] },
    output: { schema: { type: 'object' }, render: (args, value) => text(value) },
    async execute(args, exec) {
      await exec.runtime.refreshTitle(exec.signal);
      // Page-state ↔ network correlation (§3.3 / G2.6): one state mark per state read so the
      // timeline can replay url/title/revision changes next to the traffic they belong to.
      exec.runtime.netMark({ kind: 'state', text: 'state', url: exec.runtime.url });
      return exec.runtime.state();
    },
  });


  /* -------------------------------------------------------------------------------------------
   * Web T3 static vision (docs/t3-vision.md)
   *
   * Host responsibilities (docs/t3-implementation-plan.md §2.4): pure argument pre-checks (before
   * ensure/mkdir/CDP), source resolution + pin/release, the per-scope product store, the single
   * delivered PNG (P0 output rules + attachment), the unified `evidence.vision` v1 projection, and
   * the decision rules of `act` (§6) and `check` (§7). Pixel algorithms stay in vision-t3.js and
   * baseline storage in vision-baseline.js; neither module is modified here.
   * ----------------------------------------------------------------------------------------- */
  const T3_EVIDENCE_BYTES = 262144;
  const T3_EVIDENCE_REGIONS = 100;
  const T3_MAX_CASES = 20;
  const T3_MAX_ASSERTIONS = 32;
  const T3_MAX_FACTS = 64;
  const T3_MAX_MASKS = 64;
  const T3_MAX_ANNOTATIONS = 64;
  const T3_MAX_PREPROCESS = 8;
  const T3_ACT_MAX_AGE_MS = 30000;
  const T3_TOOL_NAMES = Object.freeze([
    'browser_vision_image', 'browser_vision_find', 'browser_vision_compare',
    'browser_vision_act', 'browser_vision_baseline', 'browser_vision_check',
  ]);
  const T3_SOURCE_KINDS = Object.freeze(['live', 'product', 'baseline']);
  const T3_WARNING_VOCABULARY = Object.freeze([
    ...(Array.isArray(vision.WARNING_VOCABULARY) ? vision.WARNING_VOCABULARY : []),
  ]);
  const T3_FACT_SOURCES = Object.freeze([
    'browser_snapshot', 'browser_node_state', 'browser_computed_style', 'browser_eval',
  ]);
  const T3_ASSERTION_TYPES = Object.freeze([
    'regression', 'layout', 'occlusion', 'overflow', 'truncation', 'color', 'missing',
  ]);
  const T3_OVERFLOW_VALUES = Object.freeze(['visible', 'hidden', 'clip', 'auto', 'scroll']);
  const T3_WHITE_SPACE_VALUES = Object.freeze(['normal', 'nowrap', 'pre', 'pre-wrap', 'pre-line', 'break-spaces']);
  const T3_TEXT_OVERFLOW_VALUES = Object.freeze(['clip', 'ellipsis']);
  const T3_ALGORITHM_VERSION = (() => {
    const value = vision.VISION_ALGORITHM_VERSION;
    return typeof value === 'string' && value ? value : 't3-v1';
  })();
  const T3_LIMITS = (() => {
    const source = vision.VISION_LIMITS && typeof vision.VISION_LIMITS === 'object' ? vision.VISION_LIMITS : {};
    return {
      maxProducts: Number.isFinite(source.maxProducts) ? source.maxProducts : 16,
      maxTotalBytes: Number.isFinite(source.maxTotalBytes) ? source.maxTotalBytes : 128 * 1024 * 1024,
      maxProductBytes: Number.isFinite(source.maxProductBytes) ? source.maxProductBytes : 32 * 1024 * 1024,
      maxProductPixels: Number.isFinite(source.maxProductPixels) ? source.maxProductPixels : 16000000,
      maxWorkingSetBytes: Number.isFinite(source.maxWorkingSetBytes) ? source.maxWorkingSetBytes : 256 * 1024 * 1024,
      maxTemplateComparisons: Number.isFinite(source.maxTemplateComparisons) ? source.maxTemplateComparisons : 50000000,
      algorithmBudgetMs: Number.isFinite(source.algorithmBudgetMs) ? source.algorithmBudgetMs : 5000,
      maxOutputPixels: Number.isFinite(source.maxOutputPixels) ? source.maxOutputPixels : 16000000,
      maxOutputBytes: Number.isFinite(source.maxOutputBytes) ? source.maxOutputBytes : 32 * 1024 * 1024,
    };
  })();
  const T3_DEFAULT_DIFF_OPTIONS = Object.freeze({ threshold: 0.1, includeAA: false, minRegionPixels: 1 });
  const T3_DEFAULT_THRESHOLDS = Object.freeze({ warnRatio: 0.001, failRatio: 0.01 });

  const t3Warning = (warnings, code) => {
    if (typeof code === 'string' && code !== '' && !warnings.includes(code)) warnings.push(code);
  };
  const t3Sha256 = (data) => createHash('sha256').update(data).digest('hex');
  const t3RgbaSha256 = (rgba) => createHash('sha256')
    .update(Buffer.from(rgba.buffer, rgba.byteOffset, rgba.byteLength)).digest('hex');
  const t3NewBudget = () => ({ startedAt: Date.now(), budgetMs: T3_LIMITS.algorithmBudgetMs });
  const t3AlgoOpts = (budget, signal) => ({
    signal,
    budgetMs: budget && Number.isFinite(budget.budgetMs) ? budget.budgetMs : T3_LIMITS.algorithmBudgetMs,
    startedAt: budget && Number.isFinite(budget.startedAt) ? budget.startedAt : Date.now(),
  });
  const t3Invalid = (message, details = {}) => new BrowserError('INVALID_ARGUMENT', message, details);

  /** Decode helper: the module reports failures as `{ok:false,code,message}` (never throws). */
  async function t3Decode(bytes, signal, budget) {
    let decoded;
    try {
      decoded = await vision.decodePngToRgbaAsync(bytes, t3AlgoOpts(budget, signal));
    } catch (error) {
      if (error instanceof BrowserError) throw error;
      throw new BrowserError('INVALID_PNG', '图像解码失败', { reason: redactText(String(error && error.message ? error.message : error)).slice(0, 200) });
    }
    if (!decoded || decoded.ok !== true) {
      throw new BrowserError(decoded && decoded.code ? decoded.code : 'INVALID_PNG',
        decoded && decoded.message ? decoded.message : '图像解码失败',
        decoded && decoded.details ? decoded.details : {});
    }
    if (!Number.isInteger(decoded.width) || !Number.isInteger(decoded.height) || !decoded.rgba) {
      throw new BrowserError('INTERNAL', '解码结果缺少尺寸或 RGBA 缓冲');
    }
    return decoded;
  }

  /**
   * Contract Mapping for a live capture (§3.1).
   *
   * `p = scale × runtimeDSF` (DSF pinned to 1) is the nominal density, but Chromium *floors* a
   * fractional clip: a 79.5×59.5 CSS clip at scale 1 comes back as 79×59 pixels. The contract says
   * the mapping must report the actual sampling, so cssPerPixel is derived from the requested CSS
   * rect and the real PNG size (axis-independent) instead of the nominal p.
   */
  function t3CaptureMapping(captured, width, height) {
    const requestedWidth = Number.isFinite(captured.region.width) && captured.region.width > 0 ? captured.region.width : width;
    const requestedHeight = Number.isFinite(captured.region.height) && captured.region.height > 0 ? captured.region.height : height;
    return {
      coordinateSpace: 'document-css-px',
      originCss: { x: captured.region.x, y: captured.region.y },
      cssPerPixel: { x: requestedWidth / width, y: requestedHeight / height },
      imagePixels: { width, height },
      capturedCssRect: {
        x: captured.region.x, y: captured.region.y,
        width: captured.region.width, height: captured.region.height,
      },
      scrollAtCapture: { x: captured.scroll.x, y: captured.scroll.y },
      viewportAtCapture: { width: captured.viewport.width, height: captured.viewport.height },
      visualViewportScale: Number.isFinite(captured.visualViewportScale) ? captured.visualViewportScale : null,
      geometryTransform: 'axis-aligned',
    };
  }

  /** Public Product projection (contract §2.2). Never contains bytes/base64. */
  function t3ProductPublic(entry) {
    if (!entry || typeof entry !== 'object') return null;
    const byteLength = Buffer.isBuffer(entry.bytes) || entry.bytes instanceof Uint8Array
      ? entry.bytes.length
      : Number.isFinite(entry.bytes) ? entry.bytes : null;
    return {
      productId: entry.productId,
      width: Number.isInteger(entry.width) ? entry.width : null,
      height: Number.isInteger(entry.height) ? entry.height : null,
      bytes: byteLength,
      sha256: typeof entry.sha256 === 'string' ? entry.sha256 : null,
      rgbaSha256: typeof entry.rgbaSha256 === 'string' ? entry.rgbaSha256 : null,
      createdAt: Number.isFinite(entry.createdAt) ? entry.createdAt : null,
      capturedAt: Number.isFinite(entry.capturedAt) ? entry.capturedAt : null,
      kind: typeof entry.kind === 'string' ? entry.kind : null,
      mapping: entry.mapping && typeof entry.mapping === 'object' ? entry.mapping : null,
      actionable: entry.actionable === true,
      parentIds: Array.isArray(entry.parentIds) ? [...entry.parentIds] : [],
      operations: Array.isArray(entry.operations)
        ? entry.operations.map((item) => ({ op: item && item.op ? item.op : null, parameters: item && item.parameters ? item.parameters : {} }))
        : [],
    };
  }

  /** Store one product and remember its provenance (act/evidence need it after pin()). */
  function t3AddProduct(runtime, entry) {
    const product = runtime.visionProducts.add({
      bytes: entry.bytes,
      width: entry.width,
      height: entry.height,
      sha256: entry.sha256,
      rgbaSha256: entry.rgbaSha256 ?? null,
      kind: entry.kind,
      mapping: entry.mapping ?? null,
      actionable: entry.actionable === true,
      parentIds: entry.parentIds ?? [],
      operations: entry.operations ?? [],
      createdAt: Date.now(),
      capturedAt: entry.capturedAt ?? null,
    });
    if (!product || typeof product.productId !== 'string') {
      throw new BrowserError('INTERNAL', 'product store 未返回 productId');
    }
    runtime.visionProvenance.set(product.productId, entry.provenance ?? null);
    return product;
  }

  function t3Provenance(runtime, exec) {
    return {
      actionId: exec && exec.meta ? exec.meta.actionId ?? null : null,
      scopeId: runtime.scope ? runtime.scope.id : null,
      runtimeId: runtime.runtimeId ?? null,
      pageGeneration: runtime.pageGeneration(),
      documentEpoch: runtime.documentEpoch(),
    };
  }

  /** Release every product pinned by one tool call (never throws). */
  function t3ReleasePins(runtime, pins) {
    for (const productId of pins) {
      try { runtime.visionProducts.release(productId); } catch { /* ignore */ }
    }
    pins.length = 0;
  }

  /**
   * Re-normalise an already validated Source. The module rejects an explicit `region: null`, so a
   * normalised live source must be rebuilt with the absent field omitted (idempotent otherwise).
   */
  function t3SourceForResolve(source, label) {
    if (!source || typeof source !== 'object' || typeof source.kind !== 'string') {
      return vision.validateSource(source, label);
    }
    if (source.kind === 'live') {
      // `scale` is forwarded only when the caller actually gave one: the validator keeps the
      // "omitted" state so the Host can resolve the shared view.scale inside this call
      // (docs/viewport-control.md §6.1). Defaulting to 1 here would freeze the old behaviour.
      return vision.validateSource({
        kind: 'live',
        ...(source.scale !== undefined ? { scale: source.scale } : {}),
        ...(source.region ? { region: source.region } : {}),
      }, label);
    }
    if (source.kind === 'product') return vision.validateSource({ kind: 'product', productId: source.productId }, label);
    return vision.validateSource({
      kind: 'baseline',
      name: source.name,
      ...(source.revision ? { revision: source.revision } : {}),
    }, label);
  }

  /**
   * Resolve one `Source` (contract §1.1) into bytes + decoded image + evidence source entry.
   * `role` is only used for evidence; every pin is released by the caller in `finally`.
   * The returned `captureFacts` is the ancestor capture lineage (act re-capture/age checks).
   */
  async function t3ResolveSource(runtime, exec, source, role, pins, budget, liveScale = null) {
    const normalized = t3SourceForResolve(source, 'source');
    if (normalized.kind === 'live') {
      // §3.1: a live CssRect must be inside the live cssContentSize; reject BEFORE the capture.
      const metrics = await runtime.layoutMetrics(exec.signal);
      if (normalized.region) {
        const r = normalized.region;
        if (!(r.x >= 0 && r.y >= 0 && r.width >= 1 && r.height >= 1)) {
          throw t3Invalid('source.region 非法', { path: 'source.region', reason: 'region-invalid' });
        }
        if (Number.isFinite(metrics.contentSize.width) && r.x + r.width > metrics.contentSize.width + 1e-9) {
          throw t3Invalid('source.region 超出文档宽度', { path: 'source.region', reason: 'region-outside-document' });
        }
        if (Number.isFinite(metrics.contentSize.height) && r.y + r.height > metrics.contentSize.height + 1e-9) {
          throw t3Invalid('source.region 超出文档高度', { path: 'source.region', reason: 'region-outside-document' });
        }
      }
      // One frozen default per tool call: an omitted source.scale follows the shared view.scale
      // (the caller captured it once before resolving any source), an explicit one wins.
      const resolvedScale = normalized.scale !== undefined
        ? normalized.scale
        : (Number.isFinite(liveScale) ? liveScale : runtime.view.scale);
      const scaleSource = normalized.scale !== undefined ? 'explicit' : 'view';
      const shot = await runtime.capture({
        scale: resolvedScale, region: normalized.region ?? undefined, scaleSource,
      }, exec.signal);
      const png = inspectPng(shot.pngBytes, { checkCrc: true });
      if (!png.ok) {
        throw new BrowserError('INVALID_PNG', '实时采集返回的字节不是结构完整的 PNG（不交付坏图）', {
          phase: 'inspectPng', reason: png.message,
        });
      }
      const expected = expectedPixelSize({
        width: shot.capture.region.width,
        height: shot.capture.region.height,
        scale: shot.capture.requestedScale,
        deviceScaleFactor: shot.capture.deviceScaleFactor,
      });
      // Chromium floors a fractional clip (79.5 CSS @1 → 79 px). A ≤1 px difference per axis is that
      // rounding, not a size mismatch: accept the actual sampling and let the mapping report it
      // (§3.1). Anything larger is refused. `browser_screenshot` keeps its strict P0 behaviour.
      const sizeDelta = { x: Math.abs(png.width - expected.width), y: Math.abs(png.height - expected.height) };
      if (sizeDelta.x > 1 || sizeDelta.y > 1) {
        throw new BrowserError('CAPTURE_SIZE_MISMATCH', '实时采集尺寸与期望相差超过 1px（不交付图片）', {
          actual: { width: png.width, height: png.height },
          expected: { width: expected.width, height: expected.height },
          tolerance: 1,
        });
      }
      const sizeTolerance = {
        expected: { width: expected.width, height: expected.height },
        actual: { width: png.width, height: png.height },
        maxDeltaPx: 1,
        delta: sizeDelta,
      };
      const decoded = await t3Decode(shot.pngBytes, exec.signal, budget);
      const mapping = t3CaptureMapping(shot.capture, decoded.width, decoded.height);
      const sha256 = t3Sha256(shot.pngBytes);
      const capture = {
        version: 1,
        format: 'png',
        transport: 'cdp-page-capture-screenshot',
        request: {
          scale: shot.capture.requestedScale,
          scaleSource: shot.capture.scaleSource ?? scaleSource,
          viewRevision: Number.isFinite(shot.capture.viewRevision) ? shot.capture.viewRevision : null,
          region: normalized.region ? { ...normalized.region } : null,
          coordinateSpace: 'document-css-px',
          out: null,
          persist: false,
        },
        environment: {
          browser: 'chromium',
          headless: null,
          headlessSource: null,
          pageDevicePixelRatio: Number.isFinite(shot.capture.pageDevicePixelRatio) ? shot.capture.pageDevicePixelRatio : null,
          deviceScaleFactor: shot.capture.deviceScaleFactor,
          deviceScaleFactorSource: shot.capture.deviceScaleFactorSource,
          viewport: { width: shot.capture.viewport.width, height: shot.capture.viewport.height },
          scroll: { x: shot.capture.scroll.x, y: shot.capture.scroll.y },
        },
        png: { width: png.width, height: png.height, bytes: shot.pngBytes.length, chunks: png.chunks ?? null, crc: 'ok' },
        expected: { width: expected.width, height: expected.height, pixelsPerCssPixel: expected.pixelsPerCssPixel },
        sizeCheck: {
          ok: true,
          actual: { width: png.width, height: png.height },
          expected: { width: expected.width, height: expected.height },
          upscaled: false,
          tolerancePx: 1,
          delta: sizeDelta,
        },
        sizeTolerance,
        mapping,
        anomaly: { checked: false, uniform: null, transparent: null, sampledPixels: 0, distinctColors: null, averageColor: null, maxDelta: null, tolerance: 0 },
        file: null,
        delivery: {
          original: { width: png.width, height: png.height, bytes: shot.pngBytes.length, sha256, mediaType: 'image/png' },
          image: null,
          downscaled: false,
          reencoded: false,
        },
        warnings: [],
      };
      const captureFacts = {
        region: { ...shot.capture.region },
        scale: shot.capture.requestedScale,
        scroll: { x: shot.capture.scroll.x, y: shot.capture.scroll.y },
        viewport: { width: shot.capture.viewport.width, height: shot.capture.viewport.height },
        visualViewportScale: Number.isFinite(shot.capture.visualViewportScale) ? shot.capture.visualViewportScale : null,
        capturedAt: shot.capture.capturedAt,
        sha256,
        rgbaSha256: t3RgbaSha256(decoded.rgba),
      };
      const product = t3AddProduct(runtime, {
        bytes: shot.pngBytes, width: decoded.width, height: decoded.height,
        sha256, rgbaSha256: captureFacts.rgbaSha256, kind: 'capture', mapping,
        actionable: true, parentIds: [], operations: [], capturedAt: shot.capture.capturedAt,
        provenance: { ...t3Provenance(runtime, exec), capture: captureFacts },
      });
      pins.push(product.productId);
      return {
        kind: 'live', role,
        product: t3ProductPublic(product),
        bytes: shot.pngBytes,
        sha256,
        image: { width: decoded.width, height: decoded.height, rgba: decoded.rgba },
        capture,
        captureFacts,
      };
    }
    if (normalized.kind === 'product') {
      const entry = runtime.visionProducts.pin(normalized.productId);
      if (!entry) {
        throw new BrowserError('VISION_SOURCE_NOT_FOUND', 'product 不存在、已淘汰或不属于本工作区', {
          productId: normalized.productId,
        });
      }
      pins.push(normalized.productId);
      const bytes = Buffer.isBuffer(entry.bytes) ? entry.bytes
        : entry.bytes instanceof Uint8Array ? Buffer.from(entry.bytes) : null;
      if (!bytes) throw new BrowserError('INTERNAL', 'product 条目缺少编码字节');
      const decoded = await t3Decode(bytes, exec.signal, budget);
      const stored = runtime.visionProvenance.get(normalized.productId) || null;
      return {
        kind: 'product', role,
        product: t3ProductPublic(entry),
        bytes,
        sha256: typeof entry.sha256 === 'string' ? entry.sha256 : t3Sha256(bytes),
        image: { width: decoded.width, height: decoded.height, rgba: decoded.rgba },
        capture: null,
        captureFacts: stored && stored.capture ? stored.capture : null,
      };
    }
    // baseline source: read-only, never creates the managed root/directories.
    const store = t3BaselineStore(runtime, exec);
    const got = await store.get(normalized.name, normalized.revision);
    if (!got || !got.meta || !got.pngBytes) {
      throw new BrowserError('VISION_BASELINE_NOT_FOUND', '基线不可读', { name: normalized.name, revision: normalized.revision ?? null });
    }
    const bytes = Buffer.isBuffer(got.pngBytes) ? got.pngBytes : Buffer.from(got.pngBytes);
    const decoded = await t3Decode(bytes, exec.signal, budget);
    const product = t3AddProduct(runtime, {
      bytes, width: decoded.width, height: decoded.height,
      sha256: t3Sha256(bytes), rgbaSha256: t3RgbaSha256(decoded.rgba), kind: 'baseline',
      mapping: got.meta.mapping ?? null, actionable: false, parentIds: [], operations: [],
      capturedAt: null, provenance: t3Provenance(runtime, exec),
    });
    pins.push(product.productId);
    return {
      kind: 'baseline', role,
      product: t3ProductPublic(product),
      bytes,
      sha256: t3Sha256(bytes),
      image: { width: decoded.width, height: decoded.height, rgba: decoded.rgba },
      capture: null,
      captureFacts: null,
      baseline: got.meta,
    };
  }

  /** Resolve the trusted persistent baseline root (P0 rules) and build the managed store. */
  function t3BaselineStore(runtime, exec) {
    const envRoot = captureEnvRoot();
    let root = null;
    let reason = null;
    if (envRoot !== null) {
      // A configured-but-invalid root never falls back to the workspace (contract §8.1).
      try {
        const info = statSync(envRoot);
        if (!info.isDirectory()) reason = 'env-root-not-directory';
        else root = realpathSync(envRoot);
      } catch {
        reason = 'env-root-unavailable';
      }
    } else {
      const resolved = captureRootFor(exec);
      if (resolved.root === null) reason = 'no-workspace-root';
      else {
        try {
          const info = statSync(resolved.root);
          if (!info.isDirectory()) reason = 'workspace-root-not-directory';
          else root = realpathSync(resolved.root);
        } catch {
          reason = 'workspace-root-unavailable';
        }
      }
    }
    if (root === null) {
      throw new BrowserError('VISION_BASELINE_ROOT_UNAVAILABLE', '没有可用的可信持久根，无法使用视觉基线', { reason });
    }
    return createBaselineStore({ root, scopeId: runtime.scope.id, now: () => Date.now() });
  }

  /** Evidence source projection (§3.2): product/baseline carry lineage only, live carries CaptureV1. */
  function t3EvidenceSource(resolved, role) {
    return {
      role,
      kind: resolved.kind,
      productId: resolved.product ? resolved.product.productId : null,
      sha256: resolved.sha256 ?? null,
      width: resolved.image ? resolved.image.width : (resolved.product ? resolved.product.width : null),
      height: resolved.image ? resolved.image.height : (resolved.product ? resolved.product.height : null),
      capturedAt: resolved.product ? resolved.product.capturedAt : null,
      mapping: resolved.product ? resolved.product.mapping : null,
      capture: resolved.kind === 'live' ? resolved.capture : null,
    };
  }

  /** Unified `evidence.vision` v1 (§3.2); every field is present, unknown observations are null. */
  function t3Evidence(input) {
    const provenance = input.provenance || {};
    const verdict = input.verdict || { status: 'INCONCLUSIVE', reason: 'no-assertion' };
    return {
      version: 1,
      operation: input.operation,
      provenance: {
        actionId: provenance.actionId ?? null,
        scopeId: provenance.scopeId ?? null,
        runtimeId: provenance.runtimeId ?? null,
        pageGeneration: Number.isInteger(provenance.pageGeneration) ? provenance.pageGeneration : null,
        documentEpoch: Number.isInteger(provenance.documentEpoch) ? provenance.documentEpoch : null,
        algorithmVersion: T3_ALGORITHM_VERSION,
      },
      source: Array.isArray(input.source) ? input.source : [],
      coordinateSpace: { image: 'image-px', document: 'document-css-px', input: 'viewport-css-px' },
      regions: Array.isArray(input.regions) ? input.regions : [],
      metrics: input.metrics && typeof input.metrics === 'object' ? input.metrics : {},
      baseline: Array.isArray(input.baseline) ? input.baseline : [],
      facts: Array.isArray(input.facts) ? input.facts : [],
      verdict: { status: verdict.status, reason: verdict.reason },
      dispatch: input.dispatch && typeof input.dispatch === 'object' ? {
        started: input.dispatch.started === true,
        eventCount: Number.isInteger(input.dispatch.eventCount) ? input.dispatch.eventCount : 0,
        completed: input.dispatch.completed === true,
        eventSource: input.dispatch.eventSource === 'cdp-input' ? 'cdp-input' : null,
        hitBackendNodeId: Number.isInteger(input.dispatch.hitBackendNodeId) ? input.dispatch.hitBackendNodeId : null,
      } : { started: false, eventCount: 0, completed: false, eventSource: null, hitBackendNodeId: null },
      output: input.output && typeof input.output === 'object' ? {
        productId: input.output.productId ?? null,
        sha256: input.output.sha256 ?? null,
        file: input.output.file ?? null,
        delivery: input.output.delivery ?? null,
      } : { productId: null, sha256: null, file: null, delivery: null },
      escalation: input.escalation && typeof input.escalation === 'object'
        ? { tier: input.escalation.tier === 'T4' ? 'T4' : null, reason: input.escalation.reason ?? null }
        : { tier: null, reason: null },
      incomplete: Array.isArray(input.incomplete) ? [...input.incomplete] : [],
      truncated: input.truncated === true,
    };
  }

  /**
   * Bound the evidence (§3.2): regions ≤100, JSON ≤262144 bytes. Only optional detail is dropped
   * (facts → baseline → capture payload → regions → warnings); totals, thresholds, dispatch and the
   * verdict always survive, and the loss is always reported via `truncated`.
   */
  function t3BoundEvidence(evidence) {
    if (evidence.regions.length > T3_EVIDENCE_REGIONS) {
      evidence.regions = evidence.regions.slice(0, T3_EVIDENCE_REGIONS);
      evidence.truncated = true;
    }
    const size = () => Buffer.byteLength(JSON.stringify(evidence), 'utf8');
    if (size() <= T3_EVIDENCE_BYTES) return evidence;
    evidence.truncated = true;
    const drops = [
      () => { if (evidence.facts.length) { evidence.facts = []; return true; } return false; },
      () => { if (evidence.baseline.length) { evidence.baseline = []; return true; } return false; },
      () => {
        for (const entry of evidence.source) {
          if (entry && entry.capture) {
            entry.capture = {
              version: 1,
              format: 'png',
              transport: 'cdp-page-capture-screenshot',
              png: { width: entry.width, height: entry.height, bytes: null, chunks: null, crc: null },
              file: null,
              truncated: true,
            };
            return true;
          }
        }
        return false;
      },
      () => { if (evidence.regions.length > 20) { evidence.regions = evidence.regions.slice(0, 20); return true; } return false; },
      () => { if (evidence.metrics && Array.isArray(evidence.metrics.warnings) && evidence.metrics.warnings.length) { evidence.metrics.warnings = []; return true; } return false; },
      () => { if (evidence.source.length > 4) { evidence.source = evidence.source.slice(0, 4); return true; } return false; },
    ];
    for (const drop of drops) {
      if (size() <= T3_EVIDENCE_BYTES) break;
      drop();
    }
    if (size() > T3_EVIDENCE_BYTES) {
      // Last resort: keep the verdict + dispatch + output, drop the bulky per-region detail.
      evidence.regions = [];
      evidence.metrics = { warnings: [], evidenceTruncated: true };
      evidence.incomplete = [...evidence.incomplete, 'evidence-truncated'];
    }
    return evidence;
  }

  /** Throw with the complete vision evidence attached (success and failure both carry it). */
  function t3ThrowWithEvidence(error, evidence) {
    const classified = error instanceof BrowserError ? error : new BrowserError('INTERNAL', String(error && error.message ? error.message : error));
    const bounded = t3BoundEvidence(evidence);
    classified.details = { ...classified.details, evidence: { ...classified.details?.evidence, vision: bounded } };
    return classified;
  }

  /**
   * Deliver exactly one PNG for a vision call, with the P0 rules unchanged: `output.out`,
   * `output.persist:true` or a configured env root persist; otherwise the plugin staging root.
   * The same bytes are offered to the attachments service; a missing/failed service falls back to
   * base64 without ever claiming the provider saw the image.
   */
  async function t3DeliverImage(runtime, exec, output, data, width, height, warnings) {
    const request = output || { persist: false, out: null };
    const envRoot = captureEnvRoot();
    const persistent = request.out !== null || request.persist === true || envRoot !== null;
    const defaultName = 'output/capture/' + exec.meta.actionId + '.png';
    let target = null;
    let rootSource = null;
    if (persistent) {
      const rootInfo = captureRootFor(exec);
      if (rootInfo.root === null) {
        throw new BrowserError('OUTPUT_PATH_INVALID', '没有可用的工作区根，无法持久落盘：请省略 output.out/persist 或设置 DSH_UI_TESTING_CAPTURE_DIR', {
          reason: 'root_unknown', outRequested: request.out !== null, persistRequested: request.persist === true,
        });
      }
      rootSource = rootInfo.source;
      const resolved = resolveCapturePath({ root: rootInfo.root, out: request.out === null ? undefined : request.out, defaultName });
      if (!resolved.ok) throw new BrowserError('OUTPUT_PATH_INVALID', resolved.message, resolved.details);
      target = resolved;
    }
    const sha256 = t3Sha256(data);
    let file = null;
    if (target) {
      const published = publishCapture(target.dir, target.absolutePath, data);
      if (!published.ok) throw new BrowserError(published.code, published.message, published.details);
      file = {
        path: target.relativePath, pathKind: 'relative', persistence: 'persistent',
        root: rootSource === 'env' ? 'env' : 'workspace', ephemeral: false,
        bytes: published.bytes, sha256, width, height, mode: published.mode, noClobber: true,
        createdAt: published.createdAt,
      };
    } else {
      try {
        const stagingRoot = ensureCaptureStagingRoot();
        const absolutePath = join(stagingRoot, exec.meta.actionId + '.png');
        const published = publishCapture(stagingRoot, absolutePath, data);
        if (!published.ok) throw new Error('staging publish failed: ' + published.code);
        file = {
          path: absolutePath, pathKind: 'absolute', persistence: 'staging', root: 'staging',
          ephemeral: true, bytes: published.bytes, sha256, width, height, mode: published.mode,
          noClobber: true, createdAt: published.createdAt,
        };
      } catch {
        t3Warning(warnings, 'capture_file_unavailable');
      }
    }
    const delivery = {
      original: { width, height, bytes: data.length, sha256, mediaType: 'image/png' },
      image: null, downscaled: false, reencoded: false,
    };
    let attachment;
    let attachmentError;
    let imageDelivery = 'base64-fallback';
    if (typeof attachments?.saveImage === 'function') {
      try {
        attachment = projectAttachment(await abortable(
          attachments.saveImage({ data, mediaType: 'image/png', name: `ui-testing-${exec.meta.actionId}.png` }),
          exec.signal,
        ));
      } catch (error) {
        if (error && error.code === 'ABORTED') throw error;
        attachmentError = '附件保存失败，使用 base64-fallback';
      }
      if (attachment) {
        imageDelivery = 'attachment';
        const refWidth = Number.isFinite(attachment.width) ? attachment.width : null;
        const refHeight = Number.isFinite(attachment.height) ? attachment.height : null;
        const refBytes = Number.isFinite(attachment.bytes) ? attachment.bytes : null;
        const refMediaType = typeof attachment.mediaType === 'string' ? attachment.mediaType : null;
        delivery.image = { width: refWidth, height: refHeight, bytes: refBytes, mediaType: refMediaType };
        if ((refWidth !== null && refWidth < width) || (refHeight !== null && refHeight < height)) {
          delivery.downscaled = true;
          t3Warning(warnings, 'model_image_downscaled');
        }
        if ((refMediaType !== null && refMediaType !== 'image/png')
          || (refBytes !== null && refBytes !== data.length)
          || (typeof attachment.sha256 === 'string' && attachment.sha256 !== sha256)) {
          delivery.reencoded = true;
          t3Warning(warnings, 'attachment_reencoded');
        }
      }
    } else {
      t3Warning(warnings, 'attachment_unavailable');
    }
    return {
      sha256, file, delivery,
      attachment, attachmentError, imageDelivery,
      attachmentId: attachment ? (attachment.attachmentId || attachment.id || null) : null,
    };
  }

  /** Encode a processed image with the module encoder and validate the delivered PNG. */
  async function t3EncodeImage(image, signal, budget) {
    const bytes = await vision.encodePngRgbaAsync(image, t3AlgoOpts(budget, signal));
    if (!Buffer.isBuffer(bytes) && !(bytes instanceof Uint8Array)) {
      throw new BrowserError('INTERNAL', 'PNG 编码器未返回字节');
    }
    const data = Buffer.isBuffer(bytes) ? bytes : Buffer.from(bytes);
    if (data.length > T3_LIMITS.maxOutputBytes) {
      throw new BrowserError('VISION_LIMIT_EXCEEDED', '编码 PNG 超过单图字节上限', {
        limit: 'maxOutputBytes', actual: data.length, max: T3_LIMITS.maxOutputBytes,
      });
    }
    if (image.width * image.height > T3_LIMITS.maxOutputPixels) {
      throw new BrowserError('VISION_LIMIT_EXCEEDED', '输出图像超过像素上限', {
        limit: 'maxOutputPixels', actual: image.width * image.height, max: T3_LIMITS.maxOutputPixels,
      });
    }
    const png = inspectPng(data, { checkCrc: true });
    if (!png.ok) throw new BrowserError('INVALID_PNG', '编码结果未通过 PNG 结构/CRC 校验', { phase: 'inspectPng', reason: png.message });
    if (png.width !== image.width || png.height !== image.height) {
      throw new BrowserError('CAPTURE_SIZE_MISMATCH', '编码结果尺寸与内存图像不一致', {
        actual: { width: png.width, height: png.height }, expected: { width: image.width, height: image.height },
      });
    }
    return { data, png };
  }

  /** Validate an image-space PixelRect against an image (integer, inside, no clamping). */
  function t3RectInside(rect, image, name) {
    if (rect.x + rect.width > image.width || rect.y + rect.height > image.height) {
      throw t3Invalid(`${name} 超出图像边界`, {
        path: name, reason: 'rect-outside-image',
        image: { width: image.width, height: image.height },
      });
    }
    return rect;
  }

  function t3NormalizeOutput(value) {
    if (value === undefined || value === null) return { persist: false, out: null };
    return vision.validateOutput(value, 'output');
  }

  /** Validate one `Case.assertions[].type`-specific assertion (unknown fields rejected). */
  function t3Assertion(value, name) {
    const assertion = t2Object(value, name);
    t2RejectUnknown(assertion, [
      'id', 'type', 'severity', 'baseline', 'revision', 'region', 'factId', 'expectedRect',
      'toleranceCss', 'maxCoveredRatio', 'expectedColor', 'tolerance', 'minFraction', 'query', 'minCount',
      'masks', 'options', 'thresholds',
    ], name);
    const id = t2StringField(assertion.id, { name: `${name}.id`, maxBytes: 64 });
    if (!/^[a-zA-Z0-9][a-zA-Z0-9_-]{0,63}$/.test(id)) throw t3Invalid(`${name}.id 必须是合法 Name`, { path: `${name}.id` });
    const type = t2StringField(assertion.type, { name: `${name}.type`, maxBytes: 32 });
    if (!T3_ASSERTION_TYPES.includes(type)) throw t3Invalid(`${name}.type 必须是 ${T3_ASSERTION_TYPES.join('/')}`, { path: `${name}.type` });
    const severity = assertion.severity === undefined ? 'required' : assertion.severity;
    if (severity !== 'required' && severity !== 'advisory') throw t3Invalid(`${name}.severity 只能是 required/advisory`, { path: `${name}.severity` });
    const allowedByType = {
      regression: ['id', 'type', 'severity', 'baseline', 'revision', 'region', 'masks', 'options', 'thresholds'],
      layout: ['id', 'type', 'severity', 'region', 'factId', 'expectedRect', 'toleranceCss'],
      occlusion: ['id', 'type', 'severity', 'region', 'factId', 'maxCoveredRatio'],
      overflow: ['id', 'type', 'severity', 'region', 'factId', 'toleranceCss'],
      truncation: ['id', 'type', 'severity', 'region', 'factId', 'toleranceCss'],
      color: ['id', 'type', 'severity', 'region', 'factId', 'expectedColor', 'tolerance', 'minFraction'],
      missing: ['id', 'type', 'severity', 'region', 'factId', 'query', 'minCount'],
    };
    t2RejectUnknown(assertion, allowedByType[type], `${name}(${type})`);
    const out = { id, type, severity };
    if (type === 'regression') {
      const baseline = t2StringField(assertion.baseline, { name: `${name}.baseline`, maxBytes: 64 });
      if (!/^[a-zA-Z0-9][a-zA-Z0-9_-]{0,63}$/.test(baseline)) throw t3Invalid(`${name}.baseline 必须是合法 Name`, { path: `${name}.baseline` });
      out.baseline = baseline;
      out.revision = assertion.revision === undefined ? undefined : t2IntegerField(assertion.revision, undefined, 1, 9999999999, `${name}.revision`);
      out.region = assertion.region === undefined ? undefined : vision.validatePixelRect(assertion.region, `${name}.region`);
      out.masks = assertion.masks === undefined ? undefined : vision.validateMasks(assertion.masks, `${name}.masks`);
      out.options = assertion.options === undefined ? undefined : vision.validateDiffOptions(assertion.options, `${name}.options`);
      out.thresholds = assertion.thresholds === undefined ? undefined : vision.validateThresholds(assertion.thresholds, `${name}.thresholds`);
    } else {
      out.region = vision.validatePixelRect(assertion.region, `${name}.region`);
      out.factId = assertion.factId === undefined ? undefined : t2StringField(assertion.factId, { name: `${name}.factId`, maxBytes: 64 });
      if (out.factId !== undefined && !/^[a-zA-Z0-9][a-zA-Z0-9_-]{0,63}$/.test(out.factId)) throw t3Invalid(`${name}.factId 必须是合法 Name`, { path: `${name}.factId` });
      if (type === 'layout') {
        out.expectedRect = assertion.expectedRect === undefined ? undefined : vision.validateCssRect(assertion.expectedRect, `${name}.expectedRect`);
        if (out.expectedRect !== undefined && out.factId === undefined) throw t3Invalid(`${name}.expectedRect 必须同时提供 factId`, { path: `${name}.expectedRect` });
        out.toleranceCss = t2NumberField(assertion.toleranceCss, 1, 0, 100, `${name}.toleranceCss`);
      } else if (type === 'occlusion') {
        out.maxCoveredRatio = t2NumberField(assertion.maxCoveredRatio, 0, 0, 1, `${name}.maxCoveredRatio`);
      } else if (type === 'overflow' || type === 'truncation') {
        out.toleranceCss = t2NumberField(assertion.toleranceCss, 1, 0, 100, `${name}.toleranceCss`);
      } else if (type === 'color') {
        out.expectedColor = t3Rgb(assertion.expectedColor, `${name}.expectedColor`);
        out.tolerance = t2IntegerField(assertion.tolerance, 16, 0, 255, `${name}.tolerance`);
        out.minFraction = t2NumberField(assertion.minFraction, 0.95, 0, 1, `${name}.minFraction`);
      } else if (type === 'missing') {
        out.query = vision.validateQuery(assertion.query, `${name}.query`);
        out.minCount = t2IntegerField(assertion.minCount, 1, 1, 100, `${name}.minCount`);
      }
    }
    return out;
  }

  /** `RGB` = three integers 0–255, given as `[r,g,b]` or `{r,g,b}` (contract §1.2). */
  function t3Rgb(value, name) {
    let parts;
    if (Array.isArray(value)) {
      parts = value;
    } else if (value && typeof value === 'object') {
      t2RejectUnknown(value, ['r', 'g', 'b'], name);
      if (value.r === undefined || value.g === undefined || value.b === undefined) {
        throw t3Invalid(`${name} 必须是 [r,g,b] 或 {r,g,b}`, { path: name });
      }
      parts = [value.r, value.g, value.b];
    } else {
      throw t3Invalid(`${name} 必须是 [r,g,b] 或 {r,g,b}`, { path: name });
    }
    if (parts.length !== 3) throw t3Invalid(`${name} 必须是 3 个整数通道`, { path: name });
    for (const channel of parts) {
      if (typeof channel !== 'number' || !Number.isInteger(channel) || channel < 0 || channel > 255) {
        throw t3Invalid(`${name} 每个通道必须是 0–255 整数`, { path: name });
      }
    }
    return [parts[0], parts[1], parts[2]];
  }

  /** `RGBA` = four integers 0–255, given as `[r,g,b,a]` or `{r,g,b,a}` (contract §1.2). */
  function t3Rgba(value, name) {
    let parts;
    if (Array.isArray(value)) {
      parts = value;
    } else if (value && typeof value === 'object') {
      t2RejectUnknown(value, ['r', 'g', 'b', 'a'], name);
      if (value.r === undefined || value.g === undefined || value.b === undefined || value.a === undefined) {
        throw t3Invalid(`${name} 必须是 [r,g,b,a] 或 {r,g,b,a}`, { path: name });
      }
      parts = [value.r, value.g, value.b, value.a];
    } else {
      throw t3Invalid(`${name} 必须是 [r,g,b,a] 或 {r,g,b,a}`, { path: name });
    }
    if (parts.length !== 4) throw t3Invalid(`${name} 必须是 4 个整数通道`, { path: name });
    for (const channel of parts) {
      if (typeof channel !== 'number' || !Number.isInteger(channel) || channel < 0 || channel > 255) {
        throw t3Invalid(`${name} 每个通道必须是 0–255 整数`, { path: name });
      }
    }
    return [parts[0], parts[1], parts[2], parts[3]];
  }


  /* --- T3 request validators (pure, no browser/file access) -------------------------------- */

  function t3Resize(value) {
    const object = t2Object(value, 'resize');
    t2RejectUnknown(object, ['factor', 'method'], 'resize');
    const factor = t2NumberField(object.factor, undefined, 1, 4, 'resize.factor');
    const method = object.method === undefined ? 'nearest' : object.method;
    if (method !== 'nearest' && method !== 'bilinear') throw t3Invalid('resize.method 只能是 nearest/bilinear', { path: 'resize.method' });
    return { factor, method };
  }

  function t3PreprocessParameters(op) {
    const parameters = {};
    for (const key of ['radius', 'value', 'order']) {
      if (op && op[key] !== undefined) parameters[key] = op[key];
    }
    return parameters;
  }

  /** `browser_vision_image` root arguments (contract §2.1/§2.2). */
  function t3ImageRequest(input) {
    t2RejectUnknown(input, ['source', 'region', 'resize', 'preprocess', 'annotations', 'recognize', 'output'], 'browser_vision_image');
    return {
      source: vision.validateSource(input.source, 'source'),
      region: input.region === undefined ? null : vision.validatePixelRect(input.region, 'region'),
      resize: input.resize === undefined ? null : t3Resize(input.resize),
      preprocess: vision.validatePreprocess(input.preprocess, 'preprocess'),
      annotations: vision.validateAnnotations(input.annotations, 'annotations'),
      recognize: input.recognize === undefined ? null : vision.validateQuery(input.recognize, 'recognize'),
      output: t3NormalizeOutput(input.output),
    };
  }

  /** `browser_vision_find` root arguments (contract §2.1/§2.3). */
  function t3FindRequest(input) {
    t2RejectUnknown(input, ['source', 'region', 'query'], 'browser_vision_find');
    if (input.query === undefined || input.query === null) throw t3Invalid('query 必填', { path: 'query' });
    return {
      source: vision.validateSource(input.source, 'source'),
      region: input.region === undefined ? null : vision.validatePixelRect(input.region, 'region'),
      query: vision.validateQuery(input.query, 'query'),
    };
  }

  /** `browser_vision_compare` root arguments (contract §2.1/§2.4). */
  function t3CompareRequest(input) {
    t2RejectUnknown(input, ['before', 'after', 'region', 'masks', 'options', 'thresholds', 'output'], 'browser_vision_compare');
    if (input.before === undefined || input.before === null) throw t3Invalid('before 必填（必须显式给出）', { path: 'before' });
    if (input.after === undefined || input.after === null) throw t3Invalid('after 必填（必须显式给出）', { path: 'after' });
    return {
      before: vision.validateSource(input.before, 'before'),
      after: vision.validateSource(input.after, 'after'),
      region: input.region === undefined ? null : vision.validatePixelRect(input.region, 'region'),
      masksProvided: input.masks !== undefined,
      masks: input.masks === undefined ? [] : vision.validateMasks(input.masks, 'masks'),
      optionsProvided: input.options !== undefined,
      options: input.options === undefined ? null : vision.validateDiffOptions(input.options, 'options'),
      thresholdsProvided: input.thresholds !== undefined,
      thresholds: input.thresholds === undefined ? null : vision.validateThresholds(input.thresholds, 'thresholds'),
      output: t3NormalizeOutput(input.output),
    };
  }

  /** `browser_vision_act` root arguments (contract §2.1/§2.5). */
  function t3ActRequest(input) {
    t2RejectUnknown(input, ['productId', 'action', 'point', 'to', 'button', 'clickCount', 'modifiers', 'steps', 'durationMs'], 'browser_vision_act');
    const productId = t2StringField(input.productId, { name: 'productId', maxBytes: 64 });
    if (!/^v1_[0-9a-f]{32}$/.test(productId)) throw t3Invalid('productId 必须匹配 ^v1_[0-9a-f]{32}$', { path: 'productId' });
    const action = t2StringField(input.action, { name: 'action', maxBytes: 8 });
    if (!['move', 'click', 'drag'].includes(action)) throw t3Invalid('action 只能是 move/click/drag', { path: 'action' });
    const point = vision.validatePoint(input.point, 'point');
    const hasTo = input.to !== undefined && input.to !== null;
    if (action === 'drag' && !hasTo) throw t3Invalid('drag 必须提供 to', { path: 'to' });
    if (action !== 'drag' && hasTo) throw t3Invalid(`${action} 不接受 to`, { path: 'to' });
    const to = hasTo ? vision.validatePoint(input.to, 'to') : null;
    const hasButton = input.button !== undefined;
    const hasClickCount = input.clickCount !== undefined;
    const hasSteps = input.steps !== undefined;
    const hasDuration = input.durationMs !== undefined;
    if (action === 'move') {
      if (hasButton) throw t3Invalid('move 不接受 button', { path: 'button' });
      if (hasClickCount) throw t3Invalid('move 不接受 clickCount', { path: 'clickCount' });
      if (hasSteps) throw t3Invalid('move 不接受 steps', { path: 'steps' });
      if (hasDuration) throw t3Invalid('move 不接受 durationMs', { path: 'durationMs' });
    }
    if (action === 'click' && hasSteps) throw t3Invalid('click 不接受 steps', { path: 'steps' });
    if (action === 'click' && hasDuration) throw t3Invalid('click 不接受 durationMs', { path: 'durationMs' });
    if (action === 'drag' && hasClickCount) throw t3Invalid('drag 不接受 clickCount', { path: 'clickCount' });
    const button = hasButton ? input.button : 'left';
    if (!['left', 'right', 'middle'].includes(button)) throw t3Invalid('button 只能是 left/right/middle', { path: 'button' });
    const clickCount = action === 'click'
      ? t2IntegerField(input.clickCount, 1, 1, 2, 'clickCount')
      : 1;
    const modifiers = t2ModifierList(input.modifiers);
    const steps = action === 'drag' ? t2IntegerField(input.steps, 20, 1, 100, 'steps') : 0;
    const durationMs = action === 'drag' ? t2IntegerField(input.durationMs, 500, 0, 2000, 'durationMs') : 0;
    return { productId, action, point, to, button, clickCount, modifiers, steps, durationMs };
  }

  /** `browser_vision_baseline` root arguments (contract §2.1/§2.6). */
  function t3BaselineRequest(input) {
    t2RejectUnknown(input, ['action', 'name', 'revision', 'source', 'expectedRevision', 'caseId', 'options', 'thresholds', 'masks'], 'browser_vision_baseline');
    const action = t2StringField(input.action, { name: 'action', maxBytes: 16 });
    if (!['list', 'get', 'create', 'update', 'delete'].includes(action)) {
      throw t3Invalid('action 只能是 list/get/create/update/delete', { path: 'action' });
    }
    const present = (key) => input[key] !== undefined && input[key] !== null;
    const name = present('name') ? t2StringField(input.name, { name: 'name', maxBytes: 64 }) : null;
    if (name !== null && !/^[a-zA-Z0-9][a-zA-Z0-9_-]{0,63}$/.test(name)) {
      throw new BrowserError('VISION_BASELINE_NAME_INVALID', '基线 name 必须匹配 ^[a-zA-Z0-9][a-zA-Z0-9_-]{0,63}$', { name: null });
    }
    const revision = present('revision') ? t2IntegerField(input.revision, undefined, 1, 9999999999, 'revision') : null;
    const expectedRevision = present('expectedRevision') ? t2IntegerField(input.expectedRevision, undefined, 1, 9999999999, 'expectedRevision') : null;
    const caseId = present('caseId') ? t2StringField(input.caseId, { name: 'caseId', maxBytes: 64 }) : null;
    if (caseId !== null && !/^[a-zA-Z0-9][a-zA-Z0-9_-]{0,63}$/.test(caseId)) throw t3Invalid('caseId 必须是合法 Name', { path: 'caseId' });
    const source = present('source') ? vision.validateSource(input.source, 'source') : null;
    const options = present('options') ? vision.validateDiffOptions(input.options, 'options') : null;
    const thresholds = present('thresholds') ? vision.validateThresholds(input.thresholds, 'thresholds') : null;
    // update 的 options/thresholds 按字段继承旧 HEAD 值：必须传用户给出的 partial 对象，不能传
    // 补齐默认值的完整对象，否则会静默覆盖未提供的旧字段（契约 §2.6/§8.3）。
    const optionsPartial = present('options') ? { ...input.options } : null;
    const thresholdsPartial = present('thresholds') ? { ...input.thresholds } : null;
    const masksProvided = input.masks !== undefined;
    const masks = input.masks === undefined ? [] : vision.validateMasks(input.masks, 'masks');
    const forbidden = (keys) => {
      for (const key of keys) if (present(key)) throw t3Invalid(`${action} 不接受字段：${key}`, { path: key });
    };
    if (action === 'list') {
      forbidden(['name', 'revision', 'source', 'expectedRevision', 'caseId', 'options', 'thresholds']);
      if (masksProvided) throw t3Invalid('list 不接受字段：masks', { path: 'masks' });
    } else if (action === 'get') {
      if (name === null) throw t3Invalid('get 必须提供 name', { path: 'name' });
      forbidden(['source', 'expectedRevision', 'caseId', 'options', 'thresholds']);
      if (masksProvided) throw t3Invalid('get 不接受字段：masks', { path: 'masks' });
    } else if (action === 'create') {
      if (name === null) throw t3Invalid('create 必须提供 name', { path: 'name' });
      if (source === null) throw t3Invalid('create 必须提供 source', { path: 'source' });
      forbidden(['revision', 'expectedRevision']);
    } else if (action === 'update') {
      if (name === null) throw t3Invalid('update 必须提供 name', { path: 'name' });
      if (source === null) throw t3Invalid('update 必须提供 source', { path: 'source' });
      if (expectedRevision === null) throw t3Invalid('update 必须提供 expectedRevision', { path: 'expectedRevision' });
      forbidden(['revision']);
    } else {
      if (name === null) throw t3Invalid('delete 必须提供 name', { path: 'name' });
      if (expectedRevision === null) throw t3Invalid('delete 必须提供 expectedRevision', { path: 'expectedRevision' });
      forbidden(['revision', 'source', 'caseId', 'options', 'thresholds']);
      if (masksProvided) throw t3Invalid('delete 不接受字段：masks', { path: 'masks' });
    }
    return {
      action, name, revision, source, expectedRevision, caseId, options, thresholds,
      optionsPartial, thresholdsPartial, masks, masksProvided,
    };
  }

  /** FindResult projection (§2.3): the module already returns full-image coordinates. */
  function t3FindResult(query, found, image, sourceProduct, mapping, searchRegion) {
    const candidates = Array.isArray(found && found.candidates) ? found.candidates : [];
    return {
      method: query.method,
      sourceProductId: sourceProduct ? sourceProduct.productId : null,
      searchRegion: searchRegion ?? { x: 0, y: 0, width: image.width, height: image.height },
      candidates: candidates.map((candidate) => ({
        id: candidate.id,
        region: candidate.region,
        documentCss: mapping ? vision.mapImageRectToDocument(mapping, candidate.region) : null,
        centroid: candidate.centroid,
        area: candidate.area,
        score: candidate.score,
        signal: candidate.signal,
        semanticName: null,
      })),
      totalCandidates: Number.isInteger(found && found.totalCandidates) ? found.totalCandidates : candidates.length,
      truncated: Boolean(found && found.truncated),
      metrics: found && found.metrics ? found.metrics : {
        foregroundPixels: null, evaluatedPositions: null, pixelComparisons: 0, algorithm: 'unknown',
      },
    };
  }

  /** Resolve a template Query source (product/baseline only); returns the resolved source or null. */
  async function t3TemplateImage(runtime, exec, query, pins, budget, liveScale = null) {
    if (!query || query.method !== 'template') return null;
    const template = query.template;
    if (!template) throw t3Invalid('template 查询必须提供 template source', { path: 'template' });
    if (template.kind === 'live') throw t3Invalid('template source 只能是 product 或 baseline', { path: 'template' });
    return t3ResolveSource(runtime, exec, template, 'template', pins, budget, liveScale);
  }

  function t3MergeResolved(base, provided, validator, name) {
    if (provided === null || provided === undefined) return { ...base };
    const normalized = validator(provided, name);
    const merged = { ...base };
    for (const key of Object.keys(provided)) {
      if (Object.hasOwn(normalized, key)) merged[key] = normalized[key];
    }
    return merged;
  }

  /** A ratio verdict from the module when available (equal → lower level). */
  function t3RatioVerdict(diffRatio, thresholds) {
    if (typeof vision.ratioVerdict === 'function') return vision.ratioVerdict(diffRatio, thresholds);
    if (!(diffRatio > thresholds.failRatio)) return diffRatio > thresholds.warnRatio ? 'WARN' : 'PASS';
    return 'FAIL';
  }

  function t3ValidateMaskBounds(masks, image) {
    const seen = new Set();
    masks.forEach((mask, index) => {
      if (seen.has(mask.id)) throw t3Invalid(`masks[${index}].id 重复`, { path: `masks[${index}].id` });
      seen.add(mask.id);
      const region = mask.region;
      if (region.x + region.width > image.width || region.y + region.height > image.height) {
        throw t3Invalid(`masks[${index}].region 超出图像边界`, {
          path: `masks[${index}].region`,
          image: { width: image.width, height: image.height },
        });
      }
    });
  }

  function t3EvidenceRegion(entry) {
    return {
      id: entry.id,
      role: entry.role,
      imagePixels: entry.imagePixels,
      beforeDocumentCss: entry.beforeDocumentCss ?? null,
      afterDocumentCss: entry.afterDocumentCss ?? null,
      area: Number.isInteger(entry.area) ? entry.area : null,
    };
  }

  /* --- browser_vision_image ---------------------------------------------------------------- */
  register({
    name: 'browser_vision_image',
    description: 'T3 静态视觉：对一张 PNG（live 截图 / product / 基线）做 region 裁剪、resize、预处理、全量统计、可选确定性识别（color/components/edges/template）与像素标注，并交付一张 PNG。'
      + '处理顺序固定：source → region → resize → preprocess → 统计/识别 → annotations → 编码/校验/交付；分析与识别在标注之前，regions 坐标相对最终未标注图。'
      + '无参数即一张实时截图加统计；未请求断言时 verdict=INCONCLUSIVE（reason=no-assertion），截图/识别成功都不等于视觉验收通过。'
      + '不提供 VLM/OCR/语义命名，也不读 DOM。',
    parameters: {
      type: 'object',
      additionalProperties: false,
      required: [],
      properties: {
        source: {
          type: 'object',
          description: '源图：{kind:"live",scale?:0.1–4,region?:文档CSS Rect} | {kind:"product",productId:"v1_<32hex>"} | {kind:"baseline",name,revision?}；默认 live。'
            + 'live 省略 scale 时使用本次调用开始时冻结的共享显示比例 view.scale（默认 100%），显式值覆盖且只影响本次采集。',
        },
        region: {
          type: 'object',
          description: '图像像素裁剪 Rect（integer，左闭右开，必须完全在图内）；省略为整图。',
          properties: { x: { type: 'integer' }, y: { type: 'integer' }, width: { type: 'integer' }, height: { type: 'integer' } },
          required: ['x', 'y', 'width', 'height'],
        },
        resize: {
          type: 'object',
          description: '事后位图插值（与 source.scale 的 CDP 光栅密度无关）：factor 连续 1–4（不支持缩小），method nearest/bilinear。',
          properties: { factor: { type: 'number' }, method: { type: 'string', enum: ['nearest', 'bilinear'] } },
          required: ['factor'],
        },
        preprocess: {
          type: 'array',
          description: '按列表顺序执行：grayscale/blur(radius 1–3)/normalize/threshold(value 0–255)/channels(order rgba/bgra/argb)，最多 8 项。',
          maxItems: 8,
          items: { type: 'object' },
        },
        annotations: {
          type: 'array',
          description: '整数像素标注：rect(region)/cross(point,size?)/number(point,number 1–999)/arrow(point,to)，color RGBA、thickness 1–8，最多 64 项；列表顺序即覆盖顺序。',
          maxItems: 64,
          items: { type: 'object' },
        },
        recognize: {
          type: 'object',
          description: '可选确定性识别 Query（同 browser_vision_find 的 query）；template 只接受 product/baseline 源。',
        },
        output: {
          type: 'object',
          description: '交付 PNG 的落盘选择：persist?:boolean=false（默认写插件暂存目录），out?:工作区相对 .png（提供即持久）。0600、原子写入、绝不覆盖；同 out 冲突返回 OUTPUT_EXISTS。',
          properties: { persist: { type: 'boolean' }, out: { type: 'string' } },
          required: [],
        },
      },
    },
    output: { schema: { type: 'object' }, render: (args, value) => {
      const { image, attachment, ...meta } = value;
      return attachment ? [{ type: 'image', attachment }, ...text(meta)] : text({ ...meta, image });
    } },
    async execute(args, exec) {
      const runtime = exec.runtime;
      const provenance = t3Provenance(runtime, exec);
      const pins = [];
      const budget = t3NewBudget();
      const warnings = [];
      const incomplete = [];
      let resolved = null;
      try {
        const request = t3ImageRequest(args && typeof args === 'object' ? args : {});
        // One frozen default scale per call (docs/viewport-control.md §6.1).
        const liveScale = runtime.view.scale;
        resolved = await t3ResolveSource(runtime, exec, request.source, 'source', pins, budget, liveScale);
        let image = resolved.image;
        let mapping = resolved.product ? resolved.product.mapping : null;
        let actionable = resolved.product ? resolved.product.actionable === true : false;
        const sourceProduct = resolved.product;
        const operations = [];
        if (request.region) {
          t3RectInside(request.region, image, 'region');
          image = await vision.cropImageAsync(image, request.region, t3AlgoOpts(budget, exec.signal));
          mapping = typeof vision.mappingAfterCrop === 'function' ? vision.mappingAfterCrop(mapping, request.region) : mapping;
          operations.push({ op: 'crop', parameters: { region: { ...request.region } } });
        }
        if (request.resize) {
          const outputWidth = Math.round(image.width * request.resize.factor);
          const outputHeight = Math.round(image.height * request.resize.factor);
          if (outputWidth < 1 || outputHeight < 1) throw t3Invalid('resize 结果尺寸必须 ≥1', { path: 'resize.factor' });
          if (outputWidth * outputHeight > T3_LIMITS.maxProductPixels) {
            throw new BrowserError('VISION_LIMIT_EXCEEDED', 'resize 结果超过单图像素上限', {
              limit: 'maxProductPixels', actual: outputWidth * outputHeight, max: T3_LIMITS.maxProductPixels,
            });
          }
          image = await vision.resizeImageAsync(image, request.resize.factor, request.resize.method, t3AlgoOpts(budget, exec.signal));
          mapping = typeof vision.mappingAfterResize === 'function'
            ? vision.mappingAfterResize(mapping, outputWidth, outputHeight)
            : mapping;
          operations.push({ op: 'resize', parameters: { factor: request.resize.factor, method: request.resize.method } });
          t3Warning(warnings, 'bitmap-upscaled');
          if (request.resize.method !== 'nearest') actionable = false;
        }
        for (const op of request.preprocess) {
          image = await vision.preprocessImageAsync(image, [op], t3AlgoOpts(budget, exec.signal));
          operations.push({ op: op.op, parameters: t3PreprocessParameters(op) });
          actionable = false;
        }
        // Analysis + recognition happen BEFORE annotations (annotations are not page content).
        const analysis = await vision.analyzeImageAsync(image, t3AlgoOpts(budget, exec.signal));
        let found = null;
        let templateResolved = null;
        if (request.recognize) {
          templateResolved = await t3TemplateImage(runtime, exec, request.recognize, pins, budget);
          found = await vision.findInImageAsync(image, request.recognize, {
            roi: { x: 0, y: 0, width: image.width, height: image.height },
            templateImage: templateResolved ? templateResolved.image : null,
            ...t3AlgoOpts(budget, exec.signal),
          }, t3AlgoOpts(budget, exec.signal));
        }
        let processedProduct = sourceProduct;
        let processedBytes = resolved.bytes;
        let finalImage = image;
        if (operations.length) {
          const encoded = await t3EncodeImage(image, exec.signal, budget);
          processedBytes = encoded.data;
          processedProduct = t3ProductPublic(t3AddProduct(runtime, {
            bytes: encoded.data, width: image.width, height: image.height,
            sha256: encoded.sha256, rgbaSha256: t3RgbaSha256(image.rgba), kind: 'derived',
            mapping, actionable, parentIds: [sourceProduct.productId], operations,
            capturedAt: sourceProduct.capturedAt,
            provenance: { ...provenance, capture: resolved.captureFacts ?? null },
          }));
        }
        const recognition = found
          ? t3FindResult(request.recognize, found, image, processedProduct, mapping, { x: 0, y: 0, width: image.width, height: image.height })
          : null;
        let finalProduct = processedProduct;
        let finalBytes = processedBytes;
        if (request.annotations.length) {
          finalImage = await vision.annotateImageAsync(image, request.annotations, t3AlgoOpts(budget, exec.signal));
          const encoded = await t3EncodeImage(finalImage, exec.signal, budget);
          finalBytes = encoded.data;
          finalProduct = t3ProductPublic(t3AddProduct(runtime, {
            bytes: encoded.data, width: finalImage.width, height: finalImage.height,
            sha256: encoded.sha256, rgbaSha256: t3RgbaSha256(finalImage.rgba), kind: 'derived',
            mapping, actionable: false, parentIds: [processedProduct.productId],
            operations: [{ op: 'annotate', parameters: { annotations: request.annotations } }],
            capturedAt: processedProduct.capturedAt,
            provenance: { ...provenance, capture: resolved.captureFacts ?? null },
          }));
        }
        const delivered = await t3DeliverImage(runtime, exec, request.output, finalBytes, finalImage.width, finalImage.height, warnings);
        const metrics = {
          pixelCount: analysis.pixelCount,
          transparentPixels: analysis.transparentPixels,
          opaquePixels: analysis.opaquePixels,
          uniform: analysis.uniform,
          edgePixels: analysis.edgePixels,
          edgeRatio: analysis.edgeRatio,
          operationCount: operations.length,
          annotated: request.annotations.length > 0,
          recognized: recognition ? recognition.totalCandidates : null,
          warnings,
        };
        const evidence = t3BoundEvidence(t3Evidence({
          operation: 'image',
          provenance,
          source: templateResolved
            ? [t3EvidenceSource(resolved, 'source'), t3EvidenceSource(templateResolved, 'template')]
            : [t3EvidenceSource(resolved, 'source')],
          regions: [],
          metrics,
          verdict: { status: 'INCONCLUSIVE', reason: 'no-assertion' },
          output: { productId: finalProduct.productId, sha256: delivered.sha256, file: delivered.file, delivery: delivered.delivery },
          incomplete,
        }));
        runtime.noteVisionOperation('image', 'INCONCLUSIVE');
        return {
          ok: true,
          product: finalProduct,
          image: finalBytes.toString('base64'),
          bytes: finalBytes.length,
          sha256: delivered.sha256,
          attachment: delivered.attachment,
          attachmentId: delivered.attachmentId,
          imageDelivery: delivered.imageDelivery,
          attachmentError: delivered.attachmentError,
          file: delivered.file,
          analysis,
          recognition,
          // §1.2: the success body nests the vision evidence exactly like the error path.
          evidence: { vision: evidence },
        };
      } catch (error) {
        const evidence = t3Evidence({
          operation: 'image',
          provenance,
          source: resolved ? [t3EvidenceSource(resolved, 'source')] : [],
          verdict: { status: 'BLOCKED', reason: 'error' },
          metrics: { errorCode: error && error.code ? error.code : 'INTERNAL', warnings },
          incomplete: [...incomplete, 'operation-failed'],
        });
        runtime.noteVisionOperation('image', null);
        throw t3ThrowWithEvidence(error, evidence);
      } finally {
        t3ReleasePins(runtime, pins);
      }
    },
  });

  /* --- browser_vision_find ----------------------------------------------------------------- */
  register({
    name: 'browser_vision_find',
    description: 'T3 静态视觉：在源图（可先按 region 裁出 ROI）上做确定性识别并定位，返回 FindResult。'
      + 'method=color/components/edges/template；候选坐标始终相对完整源图（ROI 原点已回加），documentCss 用 mapping 映射。'
      + '无匹配是成功（candidates:[],totalCandidates:0），不是 TARGET_NOT_FOUND；candidates 只是本次排序编号，不是可操作 ref，也不是 DOM 身份或语义命名（semanticName 恒 null）。'
      + '默认不生成图片、文件或额外 product（live 源仍会生成可引用源 product）。',
    parameters: {
      type: 'object',
      additionalProperties: false,
      required: ['query'],
      properties: {
        source: { type: 'object', description: '源图（同 browser_vision_image.source），默认 live。' },
        region: {
          type: 'object',
          description: '搜索 ROI（图像像素 integer Rect，必须完全在图内）；候选坐标仍相对完整源图。',
          properties: { x: { type: 'integer' }, y: { type: 'integer' }, width: { type: 'integer' }, height: { type: 'integer' } },
          required: ['x', 'y', 'width', 'height'],
        },
        query: { type: 'object', description: 'Query：method* + minArea?(1–16000000) + maxResults?(1–100)；color{color*:RGB,tolerance?} / components{background?,tolerance?} / edges{edgeThreshold?} / template{template*:Source(product|baseline),minScore?,stride?}。' },
      },
    },
    output: { schema: { type: 'object' }, render: (args, value) => text(value) },
    async execute(args, exec) {
      const runtime = exec.runtime;
      const provenance = t3Provenance(runtime, exec);
      const pins = [];
      const budget = t3NewBudget();
      const warnings = [];
      let resolved = null;
      try {
        const request = t3FindRequest(args && typeof args === 'object' ? args : {});
        const liveScale = runtime.view.scale;
        resolved = await t3ResolveSource(runtime, exec, request.source, 'source', pins, budget, liveScale);
        const image = resolved.image;
        const roi = request.region ? t3RectInside(request.region, image, 'region') : { x: 0, y: 0, width: image.width, height: image.height };
        const templateResolved = await t3TemplateImage(runtime, exec, request.query, pins, budget, liveScale);
        const found = await vision.findInImageAsync(image, request.query, {
          roi, templateImage: templateResolved ? templateResolved.image : null,
          ...t3AlgoOpts(budget, exec.signal),
        }, t3AlgoOpts(budget, exec.signal));
        const result = t3FindResult(request.query, found, image, resolved.product, resolved.product ? resolved.product.mapping : null, { ...roi });
        if (result.truncated) t3Warning(warnings, 'regions-truncated');
        const sourceEntries = templateResolved
          ? [t3EvidenceSource(resolved, 'source'), t3EvidenceSource(templateResolved, 'template')]
          : [t3EvidenceSource(resolved, 'source')];
        const evidence = t3BoundEvidence(t3Evidence({
          operation: 'find',
          provenance,
          source: sourceEntries,
          regions: result.candidates.map((candidate) => t3EvidenceRegion({
            id: candidate.id,
            role: 'candidate',
            imagePixels: candidate.region,
            beforeDocumentCss: candidate.documentCss,
            afterDocumentCss: null,
            area: candidate.area,
          })),
          metrics: {
            method: result.method,
            totalCandidates: result.totalCandidates,
            truncated: result.truncated,
            pixelComparisons: result.metrics ? result.metrics.pixelComparisons : null,
            foregroundPixels: result.metrics ? result.metrics.foregroundPixels : null,
            warnings,
          },
          verdict: { status: 'INCONCLUSIVE', reason: 'no-assertion' },
          incomplete: [],
        }));
        runtime.noteVisionOperation('find', 'INCONCLUSIVE');
        return { ok: true, source: resolved.product, result, evidence: { vision: evidence } };
      } catch (error) {
        const evidence = t3Evidence({
          operation: 'find',
          provenance,
          source: resolved ? [t3EvidenceSource(resolved, 'source')] : [],
          verdict: { status: 'BLOCKED', reason: 'error' },
          metrics: { errorCode: error && error.code ? error.code : 'INTERNAL', warnings },
          incomplete: ['operation-failed'],
        });
        runtime.noteVisionOperation('find', null);
        throw t3ThrowWithEvidence(error, evidence);
      } finally {
        t3ReleasePins(runtime, pins);
      }
    },
  });

  /* --- browser_vision_compare -------------------------------------------------------------- */
  register({
    name: 'browser_vision_compare',
    description: 'T3 静态视觉：对两张显式源图做 YIQ 像素差异比较（固定算法 t3-v1），输出完整尺寸的标注差异 PNG（红=差异、黄=AA、灰=mask、蓝=区域 bbox）与 PASS/WARN/FAIL。'
      + 'before/after 必须显式给出；两图必须同像素尺寸，否则 VISION_SIZE_MISMATCH；region 是两图共同的图像像素 Rect。'
      + 'masks 缺省继承 before 基线元数据（before 非基线则空），显式 [] 清空；options/thresholds 逐字段覆盖 before 基线默认。'
      + '全屏蔽无分母抛 VISION_EMPTY_COMPARISON，不返回 similarity=1；similarity 是阈值化差异覆盖率，不是语义相似度。',
    parameters: {
      type: 'object',
      additionalProperties: false,
      required: ['before', 'after'],
      properties: {
        before: { type: 'object', description: '比较前的源图（必填、显式）：Source。' },
        after: { type: 'object', description: '比较后的源图（必填、显式）：Source。' },
        region: {
          type: 'object',
          description: '比较 ROI（图像像素 integer Rect，两图都必须有效）；省略为全图。',
          properties: { x: { type: 'integer' }, y: { type: 'integer' }, width: { type: 'integer' }, height: { type: 'integer' } },
          required: ['x', 'y', 'width', 'height'],
        },
        masks: { type: 'array', description: 'Mask[]（最多 64、id 唯一）：{id,region:PixelRect}，坐标相对完整图。', maxItems: 64, items: { type: 'object' } },
        options: {
          type: 'object',
          description: 'DiffOptions：threshold 0–1（默认 0.1）、includeAA（默认 false）、minRegionPixels ≥1（默认 1）。',
          properties: { threshold: { type: 'number' }, includeAA: { type: 'boolean' }, minRegionPixels: { type: 'integer' } },
          required: [],
        },
        thresholds: {
          type: 'object',
          description: 'Thresholds：warnRatio/failRatio（0≤warn≤fail≤1，默认 0.001/0.01）。',
          properties: { warnRatio: { type: 'number' }, failRatio: { type: 'number' } },
          required: [],
        },
        output: {
          type: 'object',
          description: '差异 PNG 的落盘选择（同 browser_vision_image.output）：默认暂存，out/persist:true/env 触发持久。',
          properties: { persist: { type: 'boolean' }, out: { type: 'string' } },
          required: [],
        },
      },
    },
    output: { schema: { type: 'object' }, render: (args, value) => {
      const { image, attachment, ...meta } = value;
      return attachment ? [{ type: 'image', attachment }, ...text(meta)] : text({ ...meta, image });
    } },
    async execute(args, exec) {
      const runtime = exec.runtime;
      const provenance = t3Provenance(runtime, exec);
      const pins = [];
      const budget = t3NewBudget();
      const warnings = [];
      let resolvedBefore = null;
      let resolvedAfter = null;
      try {
        const request = t3CompareRequest(args && typeof args === 'object' ? args : {});
        // Both live sources share ONE resolved default so two images of the same call cannot fall
        // on different densities if the view scale changes between resolutions.
        const liveScale = runtime.view.scale;
        resolvedBefore = await t3ResolveSource(runtime, exec, request.before, 'before', pins, budget, liveScale);
        resolvedAfter = await t3ResolveSource(runtime, exec, request.after, 'after', pins, budget, liveScale);
        const beforeImage = resolvedBefore.image;
        const afterImage = resolvedAfter.image;
        if (beforeImage.width !== afterImage.width || beforeImage.height !== afterImage.height) {
          throw new BrowserError('VISION_SIZE_MISMATCH', '比较的两张图必须像素尺寸相同（不自动 resize/align）', {
            before: { width: beforeImage.width, height: beforeImage.height },
            after: { width: afterImage.width, height: afterImage.height },
          });
        }
        const region = request.region ? t3RectInside(request.region, beforeImage, 'region') : { x: 0, y: 0, width: beforeImage.width, height: beforeImage.height };
        const baselineMeta = resolvedBefore.kind === 'baseline' ? resolvedBefore.baseline : null;
        let masks;
        if (request.masksProvided) masks = request.masks;
        else if (baselineMeta) masks = Array.isArray(baselineMeta.masks) ? baselineMeta.masks : [];
        else masks = [];
        t3ValidateMaskBounds(masks, beforeImage);
        let options = { ...T3_DEFAULT_DIFF_OPTIONS };
        if (baselineMeta && baselineMeta.options) options = { ...options, ...baselineMeta.options };
        options = t3MergeResolved(options, request.options, vision.validateDiffOptions, 'options');
        let thresholds = { ...T3_DEFAULT_THRESHOLDS };
        if (baselineMeta && baselineMeta.thresholds) thresholds = { ...thresholds, ...baselineMeta.thresholds };
        thresholds = t3MergeResolved(thresholds, request.thresholds, vision.validateThresholds, 'thresholds');
        if (!(thresholds.warnRatio <= thresholds.failRatio)) {
          throw t3Invalid('thresholds 必须满足 0 ≤ warnRatio ≤ failRatio ≤ 1', { path: 'thresholds' });
        }
        const diff = await vision.diffImagesAsync(beforeImage, afterImage, {
          region, masks, options, ...t3AlgoOpts(budget, exec.signal),
        }, t3AlgoOpts(budget, exec.signal));
        if (!diff || !diff.metrics || diff.metrics.comparedPixels === 0) {
          throw new BrowserError('VISION_EMPTY_COMPARISON', 'ROI 内所有像素都被 mask 排除，无法计算差异比例', {
            region, maskedPixels: diff && diff.metrics ? diff.metrics.maskedPixels : null,
          });
        }
        const verdict = t3RatioVerdict(diff.metrics.diffRatio, thresholds);
        const mappingCompatible = Boolean(
          resolvedBefore.product && resolvedBefore.product.mapping
          && resolvedAfter.product && resolvedAfter.product.mapping
          && vision.mappingCompatible(resolvedBefore.product.mapping, resolvedAfter.product.mapping),
        );
        const regionList = Array.isArray(diff.regions) ? diff.regions : [];
        const comparisonRegions = regionList.map((item) => {
          const imagePixels = item.imagePixels ?? item.region ?? null;
          return {
            id: item.id,
            area: item.area,
            imagePixels,
            beforeDocumentCss: mappingCompatible && imagePixels ? vision.mapImageRectToDocument(resolvedBefore.product.mapping, imagePixels) : null,
            afterDocumentCss: mappingCompatible && imagePixels ? vision.mapImageRectToDocument(resolvedAfter.product.mapping, imagePixels) : null,
          };
        });
        if (comparisonRegions.length > T3_EVIDENCE_REGIONS) t3Warning(warnings, 'regions-truncated');
        if (!mappingCompatible) t3Warning(warnings, 'mapping-incompatible');
        const highlight = Buffer.isBuffer(diff.highlight) ? diff.highlight : Buffer.from(diff.highlight ?? []);
        const png = inspectPng(highlight, { checkCrc: true });
        if (!png.ok) throw new BrowserError('INVALID_PNG', '差异图未通过 PNG 结构/CRC 校验', { phase: 'inspectPng', reason: png.message });
        if (png.width !== beforeImage.width || png.height !== beforeImage.height) {
          throw new BrowserError('CAPTURE_SIZE_MISMATCH', '差异图尺寸必须等于完整源图尺寸', {
            actual: { width: png.width, height: png.height },
            expected: { width: beforeImage.width, height: beforeImage.height },
          });
        }
        const diffProduct = t3ProductPublic(t3AddProduct(runtime, {
          bytes: highlight, width: png.width, height: png.height, sha256: t3Sha256(highlight),
          rgbaSha256: null, kind: 'diff', mapping: null, actionable: false,
          parentIds: [resolvedBefore.product.productId, resolvedAfter.product.productId],
          operations: [{ op: 'diff', parameters: { resolvedOptions: options, resolvedThresholds: thresholds, resolvedMasks: masks } }],
          capturedAt: null, provenance,
        }));
        const delivered = await t3DeliverImage(runtime, exec, request.output, highlight, png.width, png.height, warnings);
        const comparison = {
          region,
          resolvedMasks: masks,
          resolvedOptions: options,
          resolvedThresholds: thresholds,
          metrics: diff.metrics,
          regions: comparisonRegions,
          regionCount: Number.isInteger(diff.regionCount) ? diff.regionCount : comparisonRegions.length,
          regionsTruncated: diff.regionsTruncated === true || comparisonRegions.length > T3_EVIDENCE_REGIONS,
          verdict,
          reason: 'ratio',
          mappingCompatible,
        };
        const metrics = {
          ...diff.metrics,
          warnings,
        };
        const evidence = t3BoundEvidence(t3Evidence({
          operation: 'compare',
          provenance,
          source: [t3EvidenceSource(resolvedBefore, 'before'), t3EvidenceSource(resolvedAfter, 'after')],
          regions: comparisonRegions.map((item) => t3EvidenceRegion({
            id: item.id, role: 'diff', imagePixels: item.imagePixels,
            beforeDocumentCss: item.beforeDocumentCss, afterDocumentCss: item.afterDocumentCss, area: item.area,
          })),
          metrics,
          verdict: { status: verdict, reason: 'ratio' },
          output: { productId: diffProduct.productId, sha256: delivered.sha256, file: delivered.file, delivery: delivered.delivery },
          incomplete: comparison.regionsTruncated ? ['regions-truncated'] : [],
        }));
        runtime.noteVisionOperation('compare', verdict);
        return {
          ok: true,
          before: resolvedBefore.product,
          after: resolvedAfter.product,
          product: diffProduct,
          image: highlight.toString('base64'),
          bytes: highlight.length,
          sha256: delivered.sha256,
          attachment: delivered.attachment,
          attachmentId: delivered.attachmentId,
          imageDelivery: delivered.imageDelivery,
          attachmentError: delivered.attachmentError,
          file: delivered.file,
          comparison,
          evidence: { vision: evidence },
        };
      } catch (error) {
        const sources = [];
        if (resolvedBefore) sources.push(t3EvidenceSource(resolvedBefore, 'before'));
        if (resolvedAfter) sources.push(t3EvidenceSource(resolvedAfter, 'after'));
        const evidence = t3Evidence({
          operation: 'compare',
          provenance,
          source: sources,
          verdict: { status: 'BLOCKED', reason: 'error' },
          metrics: { errorCode: error && error.code ? error.code : 'INTERNAL', warnings },
          incomplete: ['operation-failed'],
        });
        runtime.noteVisionOperation('compare', null);
        throw t3ThrowWithEvidence(error, evidence);
      } finally {
        t3ReleasePins(runtime, pins);
      }
    },
  });


  /* --- browser_vision_act ------------------------------------------------------------------ */

  const T3_MOUSE_BUTTON_BITS = Object.freeze({ left: 1, right: 2, middle: 4 });

  function t3MouseMask(button) {
    return T3_MOUSE_BUTTON_BITS[button] || 1;
  }

  function t3ModifierMask(modifiers) {
    return (modifiers || []).reduce((mask, name) => mask | (MODIFIER_BITS[name] || 0), 0);
  }

  /**
   * Hit-test one *document CSS* point (§6 step 4).
   *
   * `DOM.getNodeForLocation` takes frame-view (document) coordinates and integer values: passing a
   * viewport point or a fraction is rejected by the protocol ("Invalid parameters"). Only the hit
   * test is quantised — the dispatched Input events keep the continuous viewport coordinates.
   * CDP reports "no node at location" as an error, which is simply "no hit".
   */
  async function t3HitNode(runtime, signal, documentPoint) {
    try {
      const hit = await runtime.send('DOM.getNodeForLocation', {
        x: Math.floor(documentPoint.x),
        y: Math.floor(documentPoint.y),
        includeUserAgentShadowDOM: true,
        ignorePointerEventsNone: false,
      }, signal);
      if (!hit || !Number.isInteger(hit.backendNodeId)) return null;
      return hit;
    } catch (error) {
      if (error && error.code === 'ABORTED') throw error;
      return null;
    }
  }

  /** Live node facts for the hit node: connected / disabled / inert / bbox (CSS px). */
  async function t3NodeFacts(runtime, signal, backendNodeId) {
    let objectId = null;
    try {
      const resolved = await runtime.send('DOM.resolveNode', { backendNodeId }, signal);
      objectId = resolved && resolved.object ? resolved.object.objectId : null;
    } catch {
      objectId = null;
    }
    if (!objectId) return { connected: false, disabled: false, inert: false, rect: null };
    try {
      const evaluated = await runtime.send('Runtime.callFunctionOn', {
        objectId,
        functionDeclaration: 'function () {'
          + ' var el = this;'
          + ' if (!el || el.isConnected !== true) return { connected: false, disabled: false, inert: false, rect: null };'
          + ' var rect = el.getBoundingClientRect();'
          // Walk the composed ancestor chain (crossing shadow hosts): an inert *ancestor* makes the
          // subtree non-interactive even though `el.inert` itself is false.
          + ' var inert = false;'
          + ' var node = el;'
          + ' while (node && node.nodeType === 1) {'
          + ' if (node.inert === true || node.hasAttribute("inert")) { inert = true; break; }'
          + ' if (node.parentElement) { node = node.parentElement; continue; }'
          + ' var root = typeof node.getRootNode === "function" ? node.getRootNode() : null;'
          + ' node = root && root.host ? root.host : null;'
          + ' }'
          + ' var disabled = el.disabled === true || el.getAttribute("aria-disabled") === "true";'
          + ' return { connected: true, disabled: disabled, inert: inert,'
          + ' rect: { x: rect.x, y: rect.y, width: rect.width, height: rect.height } };'
          + ' }',
        returnByValue: true,
      }, signal);
      const value = evaluated && evaluated.result ? evaluated.result.value : null;
      if (!value || typeof value !== 'object') return { connected: false, disabled: false, inert: false, rect: null };
      return {
        connected: value.connected === true,
        disabled: value.disabled === true,
        inert: value.inert === true,
        rect: value.rect && Number.isFinite(value.rect.x) && Number.isFinite(value.rect.y)
          ? { x: value.rect.x, y: value.rect.y, width: value.rect.width, height: value.rect.height }
          : null,
      };
    } catch (error) {
      if (error && error.code === 'ABORTED') throw error;
      return { connected: false, disabled: false, inert: false, rect: null };
    }
  }

  /** Wait two animation frames (bounded); a throttled page falls back to a bounded timer. */
  async function t3NextFrames(runtime, signal) {
    try {
      // Direct CDP send: the bounded 1000ms budget must not be the 30s tool envelope.
      await runtime.cdp.send('Runtime.evaluate', {
        expression: 'new Promise(function (resolve) { requestAnimationFrame(function () { requestAnimationFrame(function () { resolve(1); }); }); })',
        awaitPromise: true,
        returnByValue: true,
      }, { signal, timeoutMs: 1000 });
    } catch (error) {
      if (error && error.code === 'ABORTED') throw error;
      await delay(32);
    }
  }

  function t3RectClose(a, b, tolerance = 1) {
    if (!a || !b) return false;
    return Math.abs(a.x - b.x) <= tolerance && Math.abs(a.y - b.y) <= tolerance
      && Math.abs(a.width - b.width) <= tolerance && Math.abs(a.height - b.height) <= tolerance;
  }

  /**
   * §6 step 4: hit identity + node state + two-frame stability. Returns the proven hit.
   * Zero dispatch on every failure path; the caller never searches for another point.
   */
  async function t3StableHit(runtime, signal, documentPoint) {
    const startedAt = Date.now();
    const first = await t3HitNode(runtime, signal, documentPoint);
    if (!first) {
      throw new BrowserError('VISION_HIT_MISMATCH', '该坐标没有可证明的命中节点（零派发）', { reason: 'no-hit' });
    }
    if (runtime.mainFrameId && first.frameId && first.frameId !== runtime.mainFrameId) {
      throw new BrowserError('UNSUPPORTED', '跨 frame 命中无法证明主 frame 归属（零派发）', { reason: 'cross-frame-hit' });
    }
    const firstFacts = await t3NodeFacts(runtime, signal, first.backendNodeId);
    if (!firstFacts.connected) {
      throw new BrowserError('VISION_HIT_MISMATCH', '命中节点未连接（零派发）', { reason: 'not-connected' });
    }
    if (firstFacts.disabled) {
      throw new BrowserError('VISION_HIT_MISMATCH', '命中节点 disabled（零派发）', { reason: 'disabled' });
    }
    if (firstFacts.inert) {
      throw new BrowserError('VISION_HIT_MISMATCH', '命中节点 inert（零派发）', { reason: 'inert' });
    }
    let previous = { backendNodeId: first.backendNodeId, rect: firstFacts.rect };
    for (let round = 0; round < 2; round += 1) {
      if (Date.now() - startedAt > 1000) {
        throw new BrowserError('VISION_HIT_MISMATCH', '命中在两帧内未稳定（零派发）', { reason: 'unstable-timeout' });
      }
      await t3NextFrames(runtime, signal);
      const hit = await t3HitNode(runtime, signal, documentPoint);
      if (!hit || hit.backendNodeId !== previous.backendNodeId) {
        throw new BrowserError('VISION_HIT_MISMATCH', '两帧命中的 backend 节点不同（零派发）', { reason: 'hit-identity-changed' });
      }
      const facts = await t3NodeFacts(runtime, signal, hit.backendNodeId);
      if (!facts.connected) {
        throw new BrowserError('VISION_HIT_MISMATCH', '命中节点在两帧间断开（零派发）', { reason: 'not-connected' });
      }
      if (!t3RectClose(previous.rect, facts.rect, 1)) {
        throw new BrowserError('VISION_HIT_MISMATCH', '命中节点 bbox 持续变化（零派发）', { reason: 'hit-rect-unstable' });
      }
      previous = { backendNodeId: hit.backendNodeId, rect: facts.rect };
    }
    return previous;
  }

  /** §6 step 5: real CDP Input dispatch (never DOM click/dispatchEvent). */
  async function t3DispatchMouse(runtime, signal, request, start, end) {
    const modifiers = t3ModifierMask(request.modifiers);
    const button = request.button;
    const buttonBit = t3MouseMask(button);
    let eventCount = 0;
    let started = false;
    let completed = false;
    let pressed = false;
    const send = async (type, x, y, extra) => {
      await runtime.send('Input.dispatchMouseEvent', { type, x, y, modifiers, ...extra }, signal);
      eventCount += 1;
    };
    try {
      if (request.action === 'move') {
        started = true;
        await send('mouseMoved', start.x, start.y, { button: 'none', buttons: 0 });
        completed = true;
      } else if (request.action === 'click') {
        started = true;
        await send('mouseMoved', start.x, start.y, { button: 'none', buttons: 0 });
        for (let count = 1; count <= request.clickCount; count += 1) {
          await send('mousePressed', start.x, start.y, { button, buttons: buttonBit, clickCount: count });
          pressed = true;
          await send('mouseReleased', start.x, start.y, { button, buttons: 0, clickCount: count });
          pressed = false;
        }
        completed = true;
      } else {
        started = true;
        await send('mouseMoved', start.x, start.y, { button: 'none', buttons: 0 });
        await send('mousePressed', start.x, start.y, { button, buttons: buttonBit, clickCount: 1 });
        pressed = true;
        const perStep = request.steps > 0 ? request.durationMs / request.steps : 0;
        for (let step = 1; step <= request.steps; step += 1) {
          const ratio = step / request.steps;
          const x = start.x + (end.x - start.x) * ratio;
          const y = start.y + (end.y - start.y) * ratio;
          if (perStep > 0) await delay(perStep);
          await send('mouseMoved', x, y, { button, buttons: buttonBit });
        }
        await send('mouseReleased', end.x, end.y, { button, buttons: 0, clickCount: 1 });
        pressed = false;
        completed = true;
      }
    } finally {
      if (pressed) {
        // Best effort: a partially dispatched drag still releases the pressed button.
        try {
          await runtime.cdp.send('Input.dispatchMouseEvent', {
            type: 'mouseReleased', x: start.x, y: start.y, button, buttons: 0, clickCount: 1, modifiers,
          }, { signal, timeoutMs: 1000 });
          eventCount += 1;
          pressed = false;
        } catch { /* the abort/disconnect path must not hang here */ }
      }
    }
    return { eventCount, started, completed, released: !pressed };
  }

  /** Evidence source entry for a pinned product (act/baseline/check reuse this projection). */
  function t3ProductSourceEntry(product, role) {
    return {
      role,
      kind: product && product.kind === 'baseline' ? 'baseline' : product && product.kind === 'capture' ? 'product' : 'product',
      productId: product ? product.productId : null,
      sha256: product ? product.sha256 : null,
      width: product ? product.width : null,
      height: product ? product.height : null,
      capturedAt: product ? product.capturedAt : null,
      mapping: product ? product.mapping : null,
      capture: null,
    };
  }

  register({
    name: 'browser_vision_act',
    description: 'T3 静态视觉：用当前截图里的坐标派发真实鼠标输入（move/click/drag）。'
      + 'productId 必须来自本工作区、capture 年龄 ≤30s、同 runtime/pageGeneration/documentEpoch 且可操作（仅 capture 或 crop+nearest derived）。'
      + '派发前依次：现场 layout/scroll/visualViewport 复验 → 同矩形重采样并比对原始 RGBA hash → 视口校验 → DOM.getNodeForLocation 命中 + connected/disabled/inert + 两帧稳定 → CDP Input 真实派发（finally 释放按键）→ 输入后单次 after product。'
      + '任何一步不满足都零派发：VISION_STALE_IMAGE / VISION_HIT_MISMATCH / NOT_INTERACTABLE(outside-viewport)。'
      + 'dispatched=true 只表示输入已派发，不代表点中业务目标或任何视觉断言通过；本工具 verdict 固定 INCONCLUSIVE(dispatch-only)。',
    parameters: {
      type: 'object',
      additionalProperties: false,
      required: ['productId', 'action', 'point'],
      properties: {
        productId: { type: 'string', description: '来自本工作区 store 的 productId（^v1_[0-9a-f]{32}$）。' },
        action: { type: 'string', enum: ['move', 'click', 'drag'], description: '动作类型。' },
        point: { type: 'object', description: '图像连续像素坐标 {x,y}（不自动加 0.5、不取整）；像素中心请传 i+0.5。', properties: { x: { type: 'number' }, y: { type: 'number' } }, required: ['x', 'y'] },
        to: { type: 'object', description: 'drag 终点（其他 action 禁止）；同样为图像连续像素坐标。', properties: { x: { type: 'number' }, y: { type: 'number' } }, required: ['x', 'y'] },
        button: { type: 'string', enum: ['left', 'right', 'middle'], description: '鼠标键（只对 click/drag，默认 left）。' },
        clickCount: { type: 'integer', description: '只对 click，1–2，默认 1。' },
        modifiers: { type: 'array', items: { type: 'string', enum: ['alt', 'ctrl', 'meta', 'shift'] }, maxItems: 4, uniqueItems: true, description: '修饰键 alt/ctrl/meta/shift（不重复，最多 4 项）。' },
        steps: { type: 'integer', description: '只对 drag，1–100，默认 20（线性路径，事件数 steps+3）。' },
        durationMs: { type: 'integer', description: '只对 drag，0–2000，默认 500（均分到移动步之间）。' },
      },
    },
    output: { schema: { type: 'object' }, render: (args, value) => text(value) },
    async execute(args, exec) {
      const runtime = exec.runtime;
      const provenance = t3Provenance(runtime, exec);
      const pins = [];
      const warnings = [];
      const incomplete = [];
      const dispatchState = { started: false, eventCount: 0, completed: false, eventSource: 'cdp-input', hitBackendNodeId: null, released: true };
      let product = null;
      let request = null;
      try {
        request = t3ActRequest(args && typeof args === 'object' ? args : {});
        const entry = runtime.visionProducts.pin(request.productId);
        if (!entry) {
          throw new BrowserError('VISION_SOURCE_NOT_FOUND', 'product 不存在、已淘汰或不属于本工作区', { productId: request.productId });
        }
        pins.push(request.productId);
        product = t3ProductPublic(entry);
        const stored = runtime.visionProvenance.get(request.productId) || null;
        const captureFacts = stored && stored.capture ? stored.capture : null;
        const ageMs = product.capturedAt === null ? null : Date.now() - product.capturedAt;
        if (!product.actionable || product.mapping === null || captureFacts === null) {
          throw new BrowserError('VISION_STALE_IMAGE', 'product 不可操作（基线/差异/预处理/标注或缺少采集映射）', {
            reason: 'not-actionable', actionable: product.actionable, mapping: product.mapping !== null,
          });
        }
        if (ageMs === null || ageMs > T3_ACT_MAX_AGE_MS) {
          throw new BrowserError('VISION_STALE_IMAGE', 'product 的采集时间超过 30s 或未知', {
            reason: 'stale-age', ageMs, maxAgeMs: T3_ACT_MAX_AGE_MS,
          });
        }
        // Same runtime / page generation / document epoch.
        if (!stored || stored.runtimeId !== runtime.runtimeId
          || stored.pageGeneration !== runtime.pageGeneration()
          || stored.documentEpoch !== runtime.documentEpoch()) {
          throw new BrowserError('VISION_STALE_IMAGE', '页面代次或文档代次已变化（截图与现场不是同一页面）', {
            reason: 'generation-changed',
            pageGeneration: runtime.pageGeneration(),
            documentEpoch: runtime.documentEpoch(),
          });
        }
        // §6 step 1: live layout/scroll/viewport/zoom re-check (no auto scroll or zoom).
        const live = await runtime.layoutMetrics(exec.signal);
        const mapping = product.mapping;
        const scrollCaptured = mapping.scrollAtCapture || { x: 0, y: 0 };
        const viewportCaptured = mapping.viewportAtCapture || { width: 0, height: 0 };
        const stale = [];
        if (Math.abs(live.scroll.x - scrollCaptured.x) > 0.01 || Math.abs(live.scroll.y - scrollCaptured.y) > 0.01) stale.push('scroll-changed');
        if (Math.abs(live.viewport.width - viewportCaptured.width) > 0.01
          || Math.abs(live.viewport.height - viewportCaptured.height) > 0.01) stale.push('viewport-changed');
        if (live.visualViewportScale !== 1) stale.push('visual-viewport-scale');
        if (mapping.visualViewportScale !== null && live.visualViewportScale !== null
          && Math.abs(mapping.visualViewportScale - live.visualViewportScale) > 1e-9) stale.push('visual-viewport-scale-changed');
        if (stale.length) {
          throw new BrowserError('VISION_STALE_IMAGE', '现场 scroll/viewport/zoom 与截图采集时不同（零派发）', {
            reason: stale[0], differences: stale,
          });
        }
        if (mapping.visualViewportScale === null) incomplete.push('visual-viewport-scale-unknown');
        // §6 step 2: re-capture the ancestor capture rect/scale and compare decoded RGBA hashes.
        const recapture = await runtime.capture({ scale: captureFacts.scale, region: captureFacts.region }, exec.signal);
        const recapturePng = inspectPng(recapture.pngBytes, { checkCrc: true });
        if (!recapturePng.ok) {
          throw new BrowserError('INVALID_PNG', '复验截图不是结构完整的 PNG', { phase: 'inspectPng', reason: recapturePng.message });
        }
        const recaptureDecoded = await t3Decode(recapture.pngBytes, exec.signal, t3NewBudget());
        const recaptureHash = t3RgbaSha256(recaptureDecoded.rgba);
        if (captureFacts.rgbaSha256 && recaptureHash !== captureFacts.rgbaSha256) {
          throw new BrowserError('VISION_STALE_IMAGE', '重新截图与原始 capture 像素不一致（页面已变化，零派发）', {
            reason: 'pixels-changed', captureSha256: captureFacts.sha256 ?? null, recaptureSha256: t3Sha256(recapture.pngBytes),
          });
        }
        // §6 step 3: image → document → viewport, then inside-viewport check.
        const documentPoint = vision.mapImagePointToDocument(mapping, request.point);
        if (!documentPoint) {
          throw new BrowserError('VISION_STALE_IMAGE', 'point 无法按 mapping 映射到文档坐标（零派发）', { reason: 'mapping-unavailable' });
        }
        const toViewport = (documentCss) => ({ x: documentCss.x - live.scroll.x, y: documentCss.y - live.scroll.y });
        const viewportPoint = toViewport(documentPoint);
        let viewportTo = null;
        let documentTo = null;
        if (request.action === 'drag') {
          documentTo = vision.mapImagePointToDocument(mapping, request.to);
          if (!documentTo) {
            throw new BrowserError('VISION_STALE_IMAGE', 'to 无法按 mapping 映射到文档坐标（零派发）', { reason: 'mapping-unavailable' });
          }
          viewportTo = toViewport(documentTo);
        }
        const insideViewport = (p) => p.x >= 0 && p.y >= 0 && p.x <= live.viewport.width && p.y <= live.viewport.height;
        if (!insideViewport(viewportPoint)) {
          throw new BrowserError('NOT_INTERACTABLE', '起点不在当前视口内（零派发，不自动滚动）', { reason: 'outside-viewport' });
        }
        if (viewportTo && !insideViewport(viewportTo)) {
          throw new BrowserError('NOT_INTERACTABLE', 'drag 终点不在当前视口内（零派发，不自动滚动）', { reason: 'outside-viewport' });
        }
        if (viewportTo) {
          for (let step = 1; step <= request.steps; step += 1) {
            const ratio = step / request.steps;
            const x = viewportPoint.x + (viewportTo.x - viewportPoint.x) * ratio;
            const y = viewportPoint.y + (viewportTo.y - viewportPoint.y) * ratio;
            if (!insideViewport({ x, y })) {
              throw new BrowserError('NOT_INTERACTABLE', 'drag 路径离开当前视口（零派发）', { reason: 'outside-viewport' });
            }
          }
        }
        // §6 step 4: hit identity + node state + two-frame stability. The hit test runs on the
        // integer document point; the dispatch below keeps the continuous viewport point.
        const hitDocument = { x: Math.floor(documentPoint.x), y: Math.floor(documentPoint.y) };
        const proven = await t3StableHit(runtime, exec.signal, hitDocument);
        dispatchState.hitBackendNodeId = proven.backendNodeId;
        // Input 前再次复验 page 代次、document 代次、scroll 与起点命中。
        if (stored.pageGeneration !== runtime.pageGeneration() || stored.documentEpoch !== runtime.documentEpoch()) {
          throw new BrowserError('VISION_STALE_IMAGE', '命中校验期间页面代次变化（零派发）', { reason: 'generation-changed' });
        }
        const liveAgain = await runtime.layoutMetrics(exec.signal);
        if (Math.abs(liveAgain.scroll.x - live.scroll.x) > 0.01 || Math.abs(liveAgain.scroll.y - live.scroll.y) > 0.01) {
          throw new BrowserError('VISION_STALE_IMAGE', '命中校验期间 scroll 变化（零派发）', { reason: 'scroll-changed' });
        }
        const hitAgain = await t3HitNode(runtime, exec.signal, hitDocument);
        if (!hitAgain || hitAgain.backendNodeId !== proven.backendNodeId) {
          throw new BrowserError('VISION_HIT_MISMATCH', '输入前命中身份变化（零派发）', { reason: 'hit-identity-changed' });
        }
        // §6 step 5: real CDP Input dispatch (finally releases the pressed button).
        const dispatched = await t3DispatchMouse(runtime, exec.signal, request, viewportPoint, viewportTo);
        dispatchState.started = dispatched.started;
        dispatchState.eventCount = dispatched.eventCount;
        dispatchState.completed = dispatched.completed;
        dispatchState.released = dispatched.released;
        // §6 step 6: one immediate after-capture of the same rect/scale (no file/base64).
        let afterProduct = null;
        try {
          const after = await runtime.capture({ scale: captureFacts.scale, region: captureFacts.region }, exec.signal);
          const afterPng = inspectPng(after.pngBytes, { checkCrc: true });
          if (!afterPng.ok) throw new Error('after PNG invalid');
          const afterDecoded = await t3Decode(after.pngBytes, exec.signal, t3NewBudget());
          const afterMapping = t3CaptureMapping(after.capture, afterDecoded.width, afterDecoded.height);
          afterProduct = t3ProductPublic(t3AddProduct(runtime, {
            bytes: after.pngBytes, width: afterDecoded.width, height: afterDecoded.height,
            sha256: t3Sha256(after.pngBytes), rgbaSha256: t3RgbaSha256(afterDecoded.rgba),
            kind: 'capture', mapping: afterMapping, actionable: true, parentIds: [], operations: [],
            capturedAt: after.capture.capturedAt,
            provenance: { ...t3Provenance(runtime, exec), capture: {
              region: after.capture.region, scale: after.capture.requestedScale,
              scroll: after.capture.scroll, viewport: after.capture.viewport,
              visualViewportScale: after.capture.visualViewportScale ?? null,
              capturedAt: after.capture.capturedAt, sha256: t3Sha256(after.pngBytes),
              rgbaSha256: t3RgbaSha256(afterDecoded.rgba),
            } },
          }));
        } catch (error) {
          if (error && error.code === 'ABORTED') throw error;
          incomplete.push('after-capture-failed');
        }
        const metrics = {
          ageMs,
          imagePixels: request.point,
          documentCss: documentPoint,
          viewportCss: viewportPoint,
          released: dispatchState.released,
          hitBackendNodeId: dispatchState.hitBackendNodeId,
          warnings,
        };
        const evidence = t3BoundEvidence(t3Evidence({
          operation: 'act',
          provenance,
          source: [t3ProductSourceEntry(product, 'source')],
          regions: [],
          metrics,
          verdict: { status: 'INCONCLUSIVE', reason: 'dispatch-only' },
          dispatch: {
            started: dispatchState.started, eventCount: dispatchState.eventCount,
            completed: dispatchState.completed, eventSource: 'cdp-input',
            hitBackendNodeId: dispatchState.hitBackendNodeId,
          },
          output: { productId: afterProduct ? afterProduct.productId : null, sha256: null, file: null, delivery: null },
          incomplete,
        }));
        runtime.noteVisionOperation('act', 'INCONCLUSIVE');
        const pointOut = {
          imagePixels: request.point,
          documentCss: documentPoint,
          viewportCss: viewportPoint,
        };
        const toOut = viewportTo ? { imagePixels: request.to, documentCss: documentTo, viewportCss: viewportTo } : null;
        return {
          ok: true,
          dispatched: dispatchState.started && dispatchState.completed,
          action: request.action,
          point: pointOut,
          to: toOut,
          dispatch: {
            eventCount: dispatchState.eventCount,
            completed: dispatchState.completed,
            eventSource: 'cdp-input',
            released: dispatchState.released,
          },
          beforeProductId: request.productId,
          afterProduct,
          evidence: { vision: evidence },
        };
      } catch (error) {
        const motion = error && error.code === 'VISION_HIT_MISMATCH'
          && error.details && error.details.reason === 'hit-rect-unstable';
        const evidence = t3Evidence({
          operation: 'act',
          provenance,
          source: product ? [t3ProductSourceEntry(product, 'source')] : [],
          verdict: { status: 'BLOCKED', reason: 'error' },
          escalation: motion ? { tier: 'T4', reason: 'target-in-motion' } : null,
          metrics: {
            errorCode: error && error.code ? error.code : 'INTERNAL',
            released: dispatchState.released,
            warnings,
          },
          dispatch: {
            started: dispatchState.started, eventCount: dispatchState.eventCount,
            completed: dispatchState.completed, eventSource: dispatchState.started ? 'cdp-input' : null,
            hitBackendNodeId: dispatchState.hitBackendNodeId,
          },
          incomplete: [...incomplete, 'operation-failed'],
        });
        runtime.noteVisionOperation('act', null);
        throw t3ThrowWithEvidence(error, evidence);
      } finally {
        t3ReleasePins(runtime, pins);
      }
    },
  });


  /* --- browser_vision_baseline -------------------------------------------------------------- */

  /** BaselineMeta projection for evidence (§3.2 `baseline[]`). */
  function t3BaselineEvidenceEntry(meta) {
    return {
      name: meta && typeof meta.name === 'string' ? meta.name : null,
      revision: meta && Number.isInteger(meta.revision) ? meta.revision : null,
      headToken: meta && typeof meta.headToken === 'string' ? meta.headToken : null,
      tombstone: Boolean(meta && meta.tombstone === true),
    };
  }

  /** `store.get` returns `{ok,meta,pngBytes}`; tolerate a bare BaselineMeta too. */
  function t3BaselineGetResult(got) {
    if (!got || typeof got !== 'object') return { meta: null, pngBytes: null };
    if (got.meta && typeof got.meta === 'object') return { meta: got.meta, pngBytes: got.pngBytes ?? null };
    return { meta: got, pngBytes: got.pngBytes ?? null };
  }

  register({
    name: 'browser_vision_baseline',
    description: 'T3 静态视觉基线（受管、不可变 revision + HEAD CAS 提交）：action=list/get/create/update/delete。'
      + 'root 沿用 P0 持久根规则（DSH_UI_TESTING_CAPTURE_DIR 优先，否则可信 exec cwd），按 scopeHash 隔离；目录 0700、文件 0600，仅 create/update 建目录，list/get/delete 只读。'
      + 'create 一次调用完成采集+PNG+元数据+HEAD 提交（不覆盖已用名字，含墓碑）；update/delete 必须给 expectedRevision（CAS，不等报 VISION_BASELINE_CONFLICT）；delete 是逻辑墓碑，不删不可变 PNG。'
      + 'source 禁止指向正在创建/更新的同名 HEAD（避免隐式自更新）。离线 list/get/delete 不启动 Chromium。',
    parameters: {
      type: 'object',
      additionalProperties: false,
      required: ['action'],
      properties: {
        action: { type: 'string', enum: ['list', 'get', 'create', 'update', 'delete'], description: '基线操作。' },
        name: { type: 'string', description: '基线名（^[a-zA-Z0-9][a-zA-Z0-9_-]{0,63}$，大小写敏感）。' },
        revision: { type: 'integer', description: 'get 可选：读取指定不可变 revision（省略为逻辑 HEAD）。' },
        source: { type: 'object', description: 'create/update 的源图（Source）；create 必填。' },
        expectedRevision: { type: 'integer', description: 'update/delete 必填：CAS 期望的当前 HEAD revision。' },
        caseId: { type: 'string', description: 'create 默认等于 name；update 缺省继承旧值。' },
        options: { type: 'object', description: 'DiffOptions（create 默认契约默认值；update 缺省继承/逐字段合并）。' },
        thresholds: { type: 'object', description: 'Thresholds（同上）。' },
        masks: { type: 'array', description: 'Mask[]（create 默认 []；update 缺省继承，显式 [] 清空）。', maxItems: 64, items: { type: 'object' } },
      },
    },
    output: { schema: { type: 'object' }, render: (args, value) => text(value) },
    async execute(args, exec) {
      const runtime = exec.runtime;
      const provenance = t3Provenance(runtime, exec);
      const pins = [];
      const warnings = [];
      let request = null;
      let resolved = null;
      let meta = null;
      try {
        request = t3BaselineRequest(args && typeof args === 'object' ? args : {});
        const store = t3BaselineStore(runtime, exec);
        if (request.action === 'list') {
          const listed = store.list();
          if (!listed || listed.ok !== true) {
            throw new BrowserError('VISION_BASELINE_READ_FAILED', '基线列表读取失败', { reason: 'io' });
          }
          const baselines = Array.isArray(listed.baselines) ? listed.baselines : [];
          const evidence = t3BoundEvidence(t3Evidence({
            operation: 'baseline',
            provenance,
            source: [],
            baseline: baselines.map(t3BaselineEvidenceEntry),
            metrics: { action: 'list', count: baselines.length, warnings },
            verdict: { status: 'INCONCLUSIVE', reason: 'baseline-management' },
            incomplete: [],
          }));
          runtime.noteVisionOperation('baseline', 'INCONCLUSIVE');
          return { ok: true, action: 'list', baselines, provenance, evidence: { vision: evidence } };
        }
        if (request.action === 'get') {
          const got = request.revision === null
            ? store.get(request.name)
            : store.get(request.name, request.revision);
          const result = t3BaselineGetResult(got);
          if (!result.meta) throw new BrowserError('VISION_BASELINE_READ_FAILED', '基线元数据不可读', { reason: 'corrupt', name: request.name });
          meta = result.meta;
          let product = null;
          if (result.pngBytes) {
            const bytes = Buffer.isBuffer(result.pngBytes) ? result.pngBytes : Buffer.from(result.pngBytes);
            const decoded = await t3Decode(bytes, exec.signal, t3NewBudget());
            product = t3ProductPublic(t3AddProduct(runtime, {
              bytes, width: decoded.width, height: decoded.height, sha256: t3Sha256(bytes),
              rgbaSha256: t3RgbaSha256(decoded.rgba), kind: 'baseline', mapping: meta.mapping ?? null,
              actionable: false, parentIds: [], operations: [], capturedAt: null, provenance,
            }));
          }
          const evidence = t3BoundEvidence(t3Evidence({
            operation: 'baseline',
            provenance,
            source: product ? [t3ProductSourceEntry(product, 'source')] : [],
            baseline: [t3BaselineEvidenceEntry(meta)],
            metrics: { action: 'get', revision: meta.revision, tombstone: meta.tombstone === true, warnings },
            verdict: { status: 'INCONCLUSIVE', reason: 'baseline-management' },
            output: { productId: product ? product.productId : null, sha256: product ? product.sha256 : null, file: null, delivery: null },
            incomplete: product ? [] : ['tombstone-revision'],
          }));
          runtime.noteVisionOperation('baseline', 'INCONCLUSIVE');
          return { ok: true, action: 'get', baseline: meta, product, provenance, evidence: { vision: evidence } };
        }
        if (request.action === 'delete') {
          const deleted = store.delete({
            name: request.name,
            actionId: exec.meta.actionId,
            expectedRevision: request.expectedRevision,
          });
          meta = deleted && deleted.meta ? deleted.meta : deleted;
          const evidence = t3BoundEvidence(t3Evidence({
            operation: 'baseline',
            provenance,
            source: [],
            baseline: [t3BaselineEvidenceEntry(meta)],
            metrics: { action: 'delete', revision: meta && meta.revision, warnings },
            verdict: { status: 'INCONCLUSIVE', reason: 'baseline-management' },
            incomplete: [],
          }));
          runtime.noteVisionOperation('baseline', 'INCONCLUSIVE');
          return { ok: true, action: 'delete', baseline: meta, provenance, evidence: { vision: evidence } };
        }
        // create / update: resolve the source (live capture or product/baseline) exactly once.
        const sameNameHead = request.source.kind === 'baseline'
          && request.source.name === request.name
          && (request.source.revision === undefined || request.source.revision === null
            || (request.action === 'update' && request.source.revision === request.expectedRevision));
        if (sameNameHead) {
          throw t3Invalid('source 不能指向正在创建/更新的同名 HEAD（避免隐式自更新）', { path: 'source' });
        }
        resolved = await t3ResolveSource(runtime, exec, request.source, 'source', pins, t3NewBudget(), runtime.view.scale);
        const sourceSummary = {
          productId: resolved.product.productId,
          sha256: resolved.sha256,
          capturedAt: resolved.product.capturedAt,
          runtimeId: provenance.runtimeId,
          pageGeneration: provenance.pageGeneration,
          documentEpoch: provenance.documentEpoch,
        };
        const payload = {
          name: request.name,
          actionId: exec.meta.actionId,
          pngBytes: resolved.bytes,
          mapping: resolved.product.mapping ?? null,
          source: sourceSummary,
        };
        if (request.action === 'create') {
          payload.caseId = request.caseId === null ? request.name : request.caseId;
          payload.options = request.options ?? { ...T3_DEFAULT_DIFF_OPTIONS };
          payload.thresholds = request.thresholds ?? { ...T3_DEFAULT_THRESHOLDS };
          payload.masks = request.masksProvided ? request.masks : [];
          meta = store.create(payload);
        } else {
          payload.expectedRevision = request.expectedRevision;
          if (request.caseId !== null) payload.caseId = request.caseId;
          if (request.optionsPartial !== null) payload.options = request.optionsPartial;
          if (request.thresholdsPartial !== null) payload.thresholds = request.thresholdsPartial;
          if (request.masksProvided) payload.masks = request.masks;
          meta = store.update(payload);
        }
        if (meta && meta.meta) meta = meta.meta;
        if (!meta || typeof meta !== 'object') throw new BrowserError('VISION_BASELINE_WRITE_FAILED', '基线写入未返回元数据', { reason: 'io' });
        const evidence = t3BoundEvidence(t3Evidence({
          operation: 'baseline',
          provenance,
          source: [t3EvidenceSource(resolved, 'source')],
          baseline: [t3BaselineEvidenceEntry(meta)],
          metrics: {
            action: request.action,
            revision: meta.revision,
            caseId: meta.caseId ?? null,
            options: meta.options ?? null,
            thresholds: meta.thresholds ?? null,
            maskCount: Array.isArray(meta.masks) ? meta.masks.length : null,
            warnings,
          },
          verdict: { status: 'INCONCLUSIVE', reason: 'baseline-management' },
          output: { productId: resolved.product.productId, sha256: resolved.sha256, file: null, delivery: null },
          incomplete: [],
        }));
        runtime.noteVisionOperation('baseline', 'INCONCLUSIVE');
        return { ok: true, action: request.action, baseline: meta, product: resolved.product, provenance, evidence: { vision: evidence } };
      } catch (error) {
        const evidence = t3Evidence({
          operation: 'baseline',
          provenance,
          source: resolved ? [t3EvidenceSource(resolved, 'source')] : [],
          baseline: meta ? [t3BaselineEvidenceEntry(meta)] : [],
          verdict: { status: 'BLOCKED', reason: 'error' },
          metrics: { errorCode: error && error.code ? error.code : 'INTERNAL', action: request ? request.action : null, warnings },
          incomplete: ['operation-failed'],
        });
        runtime.noteVisionOperation('baseline', null);
        throw t3ThrowWithEvidence(error, evidence);
      } finally {
        t3ReleasePins(runtime, pins);
      }
    },
  });


  /* --- browser_vision_check ---------------------------------------------------------------- */

  const T3_STATUS_ORDER = Object.freeze(['FAIL', 'BLOCKED', 'INCONCLUSIVE', 'WARN', 'PASS']);

  function t3Verdict(statuses) {
    for (const status of T3_STATUS_ORDER) {
      if (statuses.includes(status)) return status;
    }
    return 'PASS';
  }

  function t3RectIntersects(a, b) {
    if (!a || !b) return false;
    const width = Math.min(a.x + a.width, b.x + b.width) - Math.max(a.x, b.x);
    const height = Math.min(a.y + a.height, b.y + b.height) - Math.max(a.y, b.y);
    return width > 0 && height > 0;
  }

  /** Fact schema (§7.1): no selector/HTML/free text; every nested object rejects unknown keys. */
  function t3Fact(value, name, ids) {
    const fact = t2Object(value, name);
    t2RejectUnknown(fact, [
      'id', 'provenance', 'rect', 'containerRect', 'visible', 'hitSamples', 'scroll', 'style',
      'textMetrics', 'presence', 'allowOverflow', 'allowTruncation',
    ], name);
    const id = t2StringField(fact.id, { name: `${name}.id`, maxBytes: 64 });
    if (!/^[a-zA-Z0-9][a-zA-Z0-9_-]{0,63}$/.test(id)) throw t3Invalid(`${name}.id 必须是合法 Name`, { path: `${name}.id` });
    if (ids.has(id)) throw t3Invalid(`${name}.id 重复`, { path: `${name}.id` });
    ids.add(id);
    const provenance = t2Object(fact.provenance, `${name}.provenance`);
    t2RejectUnknown(provenance, ['sourceTool', 'sourceActionId', 'observedAt', 'scopeId', 'runtimeId', 'pageGeneration', 'documentEpoch'], `${name}.provenance`);
    const sourceTool = t2StringField(provenance.sourceTool, { name: `${name}.provenance.sourceTool`, maxBytes: 64 });
    if (!T3_FACT_SOURCES.includes(sourceTool)) {
      throw t3Invalid(`${name}.provenance.sourceTool 只能是 ${T3_FACT_SOURCES.join('/')}`, { path: `${name}.provenance.sourceTool` });
    }
    const out = {
      id,
      provenance: {
        sourceTool,
        sourceActionId: t2StringField(provenance.sourceActionId, { name: `${name}.provenance.sourceActionId`, maxBytes: 128 }),
        observedAt: t2NumberField(provenance.observedAt, undefined, 0, Number.MAX_SAFE_INTEGER, `${name}.provenance.observedAt`),
        scopeId: t2StringField(provenance.scopeId, { name: `${name}.provenance.scopeId`, maxBytes: 128 }),
        runtimeId: t2StringField(provenance.runtimeId, { name: `${name}.provenance.runtimeId`, maxBytes: 128 }),
        pageGeneration: t2IntegerField(provenance.pageGeneration, undefined, 1, Number.MAX_SAFE_INTEGER, `${name}.provenance.pageGeneration`),
        documentEpoch: t2IntegerField(provenance.documentEpoch, undefined, 0, Number.MAX_SAFE_INTEGER, `${name}.provenance.documentEpoch`),
      },
    };
    if (fact.rect !== undefined) out.rect = vision.validateCssRect(fact.rect, `${name}.rect`);
    if (fact.containerRect !== undefined) out.containerRect = vision.validateCssRect(fact.containerRect, `${name}.containerRect`);
    if (fact.visible !== undefined) out.visible = t2BooleanField(fact.visible, undefined, `${name}.visible`);
    if (fact.hitSamples !== undefined) {
      if (!Array.isArray(fact.hitSamples) || fact.hitSamples.length < 1 || fact.hitSamples.length > 25) {
        throw t3Invalid(`${name}.hitSamples 必须是 1–25 项数组`, { path: `${name}.hitSamples` });
      }
      out.hitSamples = fact.hitSamples.map((sample, index) => {
        const item = t2Object(sample, `${name}.hitSamples[${index}]`);
        t2RejectUnknown(item, ['point', 'covered'], `${name}.hitSamples[${index}]`);
        return {
          point: vision.validatePoint(item.point, `${name}.hitSamples[${index}].point`),
          covered: t2BooleanField(item.covered, undefined, `${name}.hitSamples[${index}].covered`),
        };
      });
    }
    if (fact.scroll !== undefined) {
      const scroll = t2Object(fact.scroll, `${name}.scroll`);
      t2RejectUnknown(scroll, ['scrollWidth', 'scrollHeight', 'clientWidth', 'clientHeight'], `${name}.scroll`);
      out.scroll = {
        scrollWidth: t2NumberField(scroll.scrollWidth, undefined, 0, Number.MAX_SAFE_INTEGER, `${name}.scroll.scrollWidth`),
        scrollHeight: t2NumberField(scroll.scrollHeight, undefined, 0, Number.MAX_SAFE_INTEGER, `${name}.scroll.scrollHeight`),
        clientWidth: t2NumberField(scroll.clientWidth, undefined, 0, Number.MAX_SAFE_INTEGER, `${name}.scroll.clientWidth`),
        clientHeight: t2NumberField(scroll.clientHeight, undefined, 0, Number.MAX_SAFE_INTEGER, `${name}.scroll.clientHeight`),
      };
    }
    if (fact.style !== undefined) {
      const style = t2Object(fact.style, `${name}.style`);
      const allowed = ['overflowX', 'overflowY', 'whiteSpace', 'textOverflow', 'lineClamp', 'color', 'backgroundColor'];
      t2RejectUnknown(style, allowed, `${name}.style`);
      if (Object.keys(style).length === 0) throw t3Invalid(`${name}.style 不能是空对象`, { path: `${name}.style` });
      const outStyle = {};
      if (style.overflowX !== undefined) {
        if (!T3_OVERFLOW_VALUES.includes(style.overflowX)) throw t3Invalid(`${name}.style.overflowX 非法`, { path: `${name}.style.overflowX` });
        outStyle.overflowX = style.overflowX;
      }
      if (style.overflowY !== undefined) {
        if (!T3_OVERFLOW_VALUES.includes(style.overflowY)) throw t3Invalid(`${name}.style.overflowY 非法`, { path: `${name}.style.overflowY` });
        outStyle.overflowY = style.overflowY;
      }
      if (style.whiteSpace !== undefined) {
        if (!T3_WHITE_SPACE_VALUES.includes(style.whiteSpace)) throw t3Invalid(`${name}.style.whiteSpace 非法`, { path: `${name}.style.whiteSpace` });
        outStyle.whiteSpace = style.whiteSpace;
      }
      if (style.textOverflow !== undefined) {
        if (!T3_TEXT_OVERFLOW_VALUES.includes(style.textOverflow)) throw t3Invalid(`${name}.style.textOverflow 非法`, { path: `${name}.style.textOverflow` });
        outStyle.textOverflow = style.textOverflow;
      }
      if (style.lineClamp !== undefined) outStyle.lineClamp = t2IntegerField(style.lineClamp, undefined, 0, Number.MAX_SAFE_INTEGER, `${name}.style.lineClamp`);
      if (style.color !== undefined) outStyle.color = t3Rgb(style.color, `${name}.style.color`);
      if (style.backgroundColor !== undefined) outStyle.backgroundColor = t3Rgba(style.backgroundColor, `${name}.style.backgroundColor`);
      out.style = outStyle;
    }
    if (fact.textMetrics !== undefined) {
      const metrics = t2Object(fact.textMetrics, `${name}.textMetrics`);
      t2RejectUnknown(metrics, ['contentWidth', 'contentHeight', 'availableWidth', 'availableHeight'], `${name}.textMetrics`);
      out.textMetrics = {
        contentWidth: t2NumberField(metrics.contentWidth, undefined, 0, Number.MAX_SAFE_INTEGER, `${name}.textMetrics.contentWidth`),
        contentHeight: t2NumberField(metrics.contentHeight, undefined, 0, Number.MAX_SAFE_INTEGER, `${name}.textMetrics.contentHeight`),
        availableWidth: t2NumberField(metrics.availableWidth, undefined, 0, Number.MAX_SAFE_INTEGER, `${name}.textMetrics.availableWidth`),
        availableHeight: t2NumberField(metrics.availableHeight, undefined, 0, Number.MAX_SAFE_INTEGER, `${name}.textMetrics.availableHeight`),
      };
    }
    if (fact.presence !== undefined) {
      const presence = t2Object(fact.presence, `${name}.presence`);
      t2RejectUnknown(presence, ['expected', 'exists', 'searchComplete'], `${name}.presence`);
      out.presence = {
        expected: t2BooleanField(presence.expected, undefined, `${name}.presence.expected`),
        exists: t2BooleanField(presence.exists, undefined, `${name}.presence.exists`),
        searchComplete: t2BooleanField(presence.searchComplete, undefined, `${name}.presence.searchComplete`),
      };
    }
    if (fact.allowOverflow !== undefined) out.allowOverflow = t2BooleanField(fact.allowOverflow, false, `${name}.allowOverflow`);
    if (fact.allowTruncation !== undefined) out.allowTruncation = t2BooleanField(fact.allowTruncation, false, `${name}.allowTruncation`);
    return out;
  }

  /** `browser_vision_check` root arguments: the whole batch is validated before any case runs. */
  function t3CheckRequest(input) {
    t2RejectUnknown(input, ['cases'], 'browser_vision_check');
    if (!Array.isArray(input.cases)) throw t3Invalid('cases 必须是数组', { path: 'cases' });
    if (input.cases.length < 1 || input.cases.length > T3_MAX_CASES) {
      throw t3Invalid(`cases 必须是 1–${T3_MAX_CASES} 项`, { path: 'cases', count: input.cases.length });
    }
    const caseIds = new Set();
    return input.cases.map((raw, index) => {
      const name = `cases[${index}]`;
      const item = t2Object(raw, name);
      t2RejectUnknown(item, ['id', 'source', 'assertions', 'facts'], name);
      const id = t2StringField(item.id, { name: `${name}.id`, maxBytes: 64 });
      if (!/^[a-zA-Z0-9][a-zA-Z0-9_-]{0,63}$/.test(id)) throw t3Invalid(`${name}.id 必须是合法 Name`, { path: `${name}.id` });
      if (caseIds.has(id)) throw t3Invalid(`cases[].id 重复：${id}`, { path: `${name}.id` });
      caseIds.add(id);
      if (item.source === undefined || item.source === null) throw t3Invalid(`${name}.source 必填`, { path: `${name}.source` });
      if (!Array.isArray(item.assertions)) throw t3Invalid(`${name}.assertions 必须是数组`, { path: `${name}.assertions` });
      if (item.assertions.length < 1 || item.assertions.length > T3_MAX_ASSERTIONS) {
        throw t3Invalid(`${name}.assertions 必须是 1–${T3_MAX_ASSERTIONS} 项`, { path: `${name}.assertions`, count: item.assertions.length });
      }
      const assertionIds = new Set();
      const assertions = item.assertions.map((assertion, assertionIndex) => {
        const parsed = t3Assertion(assertion, `${name}.assertions[${assertionIndex}]`);
        if (assertionIds.has(parsed.id)) throw t3Invalid(`${name}.assertions[].id 重复：${parsed.id}`, { path: `${name}.assertions[${assertionIndex}].id` });
        assertionIds.add(parsed.id);
        return parsed;
      });
      const rawFacts = item.facts === undefined ? [] : item.facts;
      if (!Array.isArray(rawFacts)) throw t3Invalid(`${name}.facts 必须是数组`, { path: `${name}.facts` });
      if (rawFacts.length > T3_MAX_FACTS) throw t3Invalid(`${name}.facts 最多 ${T3_MAX_FACTS} 项`, { path: `${name}.facts`, count: rawFacts.length });
      const factIds = new Set();
      const facts = rawFacts.map((fact, factIndex) => t3Fact(fact, `${name}.facts[${factIndex}]`, factIds));
      return {
        id,
        source: vision.validateSource(item.source, `${name}.source`),
        assertions,
        facts,
      };
    });
  }

  function t3AssertionResult(assertion, status, reason, metrics, extra = {}) {
    return {
      id: assertion.id,
      type: assertion.type,
      severity: assertion.severity,
      status,
      reason,
      metrics: metrics || {},
      regions: Array.isArray(extra.regions) ? extra.regions : [],
      factIds: Array.isArray(extra.factIds) ? extra.factIds : [],
      diffProductId: extra.diffProductId ?? null,
      errorCode: extra.errorCode ?? null,
    };
  }

  function t3BlockedAssertion(assertion, error) {
    const code = error && error.code ? error.code : 'INTERNAL';
    return t3AssertionResult(assertion, 'BLOCKED', 'execution-error', {
      errorCode: code,
    }, { errorCode: code });
  }

  /** Fact fusion gate (§7.1): scope/runtime/page/document/time must all match the case image. */
  function t3FactFor(runtime, resolved, assertion, factsById) {
    if (!assertion.factId) return { fact: null, reason: null };
    const fact = factsById.get(assertion.factId);
    if (!fact) return { fact: null, reason: 'fact-not-provided' };
    const prov = fact.provenance;
    const scopeId = runtime.scope ? runtime.scope.id : null;
    if (prov.scopeId !== scopeId || prov.runtimeId !== runtime.runtimeId
      || prov.pageGeneration !== runtime.pageGeneration()
      || prov.documentEpoch !== runtime.documentEpoch()) {
      return { fact: null, reason: 'fact-stale-or-mismatch' };
    }
    const capturedAt = resolved.product ? resolved.product.capturedAt : null;
    if (!Number.isFinite(capturedAt) || !Number.isFinite(prov.observedAt) || Math.abs(prov.observedAt - capturedAt) > 1000) {
      return { fact: null, reason: 'fact-stale-or-mismatch' };
    }
    return { fact, reason: null };
  }

  /** ROI in document CSS (needed to intersect an external fact rect with the image region). */
  function t3RegionDocumentCss(resolved, region) {
    const mapping = resolved.product ? resolved.product.mapping : null;
    if (!mapping) return null;
    return vision.mapImageRectToDocument(mapping, region);
  }

  function t3RegionInsideRoi(region, image) {
    return region.x >= 0 && region.y >= 0
      && region.x + region.width <= image.width && region.y + region.height <= image.height;
  }

  /** Pixel-only layout/overflow signal: non-background components touching the ROI edges. */
  async function t3EdgeTouchSignal(image, roi, budget, signal) {
    const found = await vision.findInImageAsync(image, {
      method: 'components', background: [255, 255, 255], tolerance: 16, minArea: 1, maxResults: 100,
    }, { roi, ...t3AlgoOpts(budget, signal) }, t3AlgoOpts(budget, signal));
    const candidates = Array.isArray(found && found.candidates) ? found.candidates : [];
    let edgeTouchCount = 0;
    for (const candidate of candidates) {
      const box = candidate.region;
      if (!box) continue;
      if (box.x <= roi.x || box.y <= roi.y
        || box.x + box.width >= roi.x + roi.width || box.y + box.height >= roi.y + roi.height) {
        edgeTouchCount += 1;
      }
    }
    return { edgeTouchCount, components: candidates.length };
  }

  /** Pixel-only occlusion signal: 4×4 grid, dominant quantized bucket ≥0.95 covering ≥ half ROI. */
  function t3OcclusionSignal(image, roi) {
    let coveredPixels = 0;
    let maxDominantFraction = null;
    for (let gy = 0; gy < 4; gy += 1) {
      for (let gx = 0; gx < 4; gx += 1) {
        const x0 = roi.x + Math.floor(gx * roi.width / 4);
        const x1 = roi.x + Math.floor((gx + 1) * roi.width / 4);
        const y0 = roi.y + Math.floor(gy * roi.height / 4);
        const y1 = roi.y + Math.floor((gy + 1) * roi.height / 4);
        if (x1 <= x0 || y1 <= y0) continue;
        const buckets = new Map();
        let nonEmpty = 0;
        for (let y = y0; y < y1; y += 1) {
          for (let x = x0; x < x1; x += 1) {
            const offset = (y * image.width + x) * 4;
            if (image.rgba[offset + 3] === 0) continue;
            nonEmpty += 1;
            const key = ((image.rgba[offset] >> 4) << 8) | ((image.rgba[offset + 1] >> 4) << 4) | (image.rgba[offset + 2] >> 4);
            buckets.set(key, (buckets.get(key) || 0) + 1);
          }
        }
        if (nonEmpty === 0) continue;
        let dominant = 0;
        for (const count of buckets.values()) dominant = Math.max(dominant, count);
        const fraction = dominant / nonEmpty;
        maxDominantFraction = maxDominantFraction === null ? fraction : Math.max(maxDominantFraction, fraction);
        if (fraction >= 0.95) coveredPixels += (x1 - x0) * (y1 - y0);
      }
    }
    const roiPixels = roi.width * roi.height;
    return {
      signal: roiPixels > 0 && coveredPixels >= roiPixels / 2 && maxDominantFraction !== null && maxDominantFraction >= 0.95,
      dominantFraction: maxDominantFraction,
      coveredPixels,
      roiPixels,
    };
  }

  /** Pixel-only truncation signal: Sobel edge pixels inside the ROI right/bottom 1px band. */
  async function t3TruncationSignal(image, roi, budget, signal) {
    const edges = await vision.edgeMaskAsync(image, 32, t3AlgoOpts(budget, signal));
    let boundaryEdgePixels = 0;
    const xEdge = roi.x + roi.width - 1;
    const yEdge = roi.y + roi.height - 1;
    for (let y = roi.y; y < roi.y + roi.height; y += 1) {
      if (xEdge >= roi.x && edges[y * image.width + xEdge]) boundaryEdgePixels += 1;
    }
    for (let x = roi.x; x < roi.x + roi.width; x += 1) {
      if (yEdge >= roi.y && edges[yEdge * image.width + x]) boundaryEdgePixels += 1;
    }
    return { boundaryEdgePixels, signal: boundaryEdgePixels > 0 };
  }

  /** Pixel-only color signal: fraction of opaque ROI pixels matching the expected RGB. */
  function t3ColorSignal(image, roi, expectedColor, tolerance, minFraction) {
    let sampledPixels = 0;
    let matchingPixels = 0;
    for (let y = roi.y; y < roi.y + roi.height; y += 1) {
      for (let x = roi.x; x < roi.x + roi.width; x += 1) {
        const offset = (y * image.width + x) * 4;
        if (image.rgba[offset + 3] === 0) continue;
        sampledPixels += 1;
        const delta = Math.max(
          Math.abs(image.rgba[offset] - expectedColor[0]),
          Math.abs(image.rgba[offset + 1] - expectedColor[1]),
          Math.abs(image.rgba[offset + 2] - expectedColor[2]),
        );
        if (delta <= tolerance) matchingPixels += 1;
      }
    }
    const matchingFraction = sampledPixels === 0 ? 0 : matchingPixels / sampledPixels;
    return {
      sampledPixels,
      matchingPixels,
      matchingFraction,
      signal: sampledPixels === 0 ? null : matchingFraction < minFraction,
    };
  }

  /** Pixel-only missing signal: explicit query candidate count inside the ROI. */
  async function t3MissingSignal(runtime, exec, image, roi, assertion, pins, budget, warnings) {
    const templateResolved = await t3TemplateImage(runtime, exec, assertion.query, pins, budget);
    const found = await vision.findInImageAsync(image, assertion.query, {
      roi, templateImage: templateResolved ? templateResolved.image : null,
      ...t3AlgoOpts(budget, exec.signal),
    }, t3AlgoOpts(budget, exec.signal));
    const candidates = Array.isArray(found && found.candidates) ? found.candidates : [];
    return {
      candidateCount: Number.isInteger(found && found.totalCandidates) ? found.totalCandidates : candidates.length,
      candidates,
      signal: candidates.length < assertion.minCount,
    };
  }

  function t3RgbDelta(a, b) {
    return Math.max(Math.abs(a[0] - b[0]), Math.abs(a[1] - b[1]), Math.abs(a[2] - b[2]));
  }

  function t3StyleBackground(fact) {
    const background = fact && fact.style ? fact.style.backgroundColor : null;
    if (!background) return null;
    if (Array.isArray(background)) {
      if (background.length !== 4) return null;
      return { rgba: background, alpha: background[3] };
    }
    if (typeof background === 'object' && background && background.a !== undefined) {
      return { rgba: [background.r, background.g, background.b, background.a], alpha: background.a };
    }
    return null;
  }

  /**
   * One defect assertion (§7.2): pixel signal + optional external fact, with the required/advisory
   * matrix. `metrics` only carries the bounded numeric/boolean fields named by the contract.
   */
  async function t3DefectAssertion(runtime, exec, testCase, assertion, resolved, factsById, pins, budget, warnings) {
    const image = resolved.image;
    const region = assertion.region;
    if (!t3RegionInsideRoi(region, image)) {
      throw t3Invalid(`${assertion.type} region 超出图像边界`, { path: `assertions[${assertion.id}].region` });
    }
    const severity = assertion.severity;
    const required = severity === 'required';
    const factMatch = t3FactFor(runtime, resolved, assertion, factsById);
    const fact = factMatch.fact;
    const factIds = fact ? [fact.id] : [];
    const metricsBase = { pixelSignal: null, factsVerified: false, fusion: 'none', warnings };
    // Every defect assertion cites its ROI as evidence (image px + document CSS when mapped).
    const roiRegion = t3EvidenceRegion({
      id: assertion.id,
      role: 'roi',
      imagePixels: region,
      beforeDocumentCss: null,
      afterDocumentCss: t3RegionDocumentCss(resolved, region),
      area: region.width * region.height,
    });
    const degraded = (reason, extra = {}) => t3AssertionResult(assertion, 'INCONCLUSIVE', reason, {
      ...metricsBase, ...extra,
    }, { factIds, regions: [roiRegion] });
    // Required defect rules need a live/capture lineage source with a usable mapping (§7.1).
    if (required) {
      if (!resolved.product || resolved.product.capturedAt === null || resolved.product.mapping === null) {
        return degraded('source-not-live');
      }
    }
    if (assertion.factId && factMatch.reason) {
      const pixelSignal = await t3PixelSignal(runtime, exec, assertion, image, region, pins, budget, warnings);
      return t3AssertionResult(assertion, required ? 'INCONCLUSIVE' : (pixelSignal.signal === true ? 'WARN' : 'INCONCLUSIVE'),
        factMatch.reason, { ...metricsBase, ...pixelSignal.metrics, pixelSignal: pixelSignal.signal, fusion: 'pixels-only' },
        { factIds: [] });
    }
    const pixelSignal = await t3PixelSignal(runtime, exec, assertion, image, region, pins, budget, warnings);
    const pixelMetrics = { ...pixelSignal.metrics, pixelSignal: pixelSignal.signal };
    if (assertion.type === 'layout') {
      if (!fact || !fact.rect || !assertion.expectedRect) {
        if (!required) return t3AssertionResult(assertion, pixelSignal.signal === true ? 'WARN' : 'INCONCLUSIVE', 'insufficient-facts', { ...metricsBase, ...pixelMetrics, fusion: 'pixels-only' }, { factIds, regions: [roiRegion] });
        return degraded('insufficient-facts', pixelMetrics);
      }
      const regionCss = t3RegionDocumentCss(resolved, region);
      if (!regionCss || !t3RectIntersects(fact.rect, regionCss)) return degraded('fact-region-mismatch', pixelMetrics);
      const maxDeltaCss = Math.max(
        Math.abs(fact.rect.x - assertion.expectedRect.x),
        Math.abs(fact.rect.y - assertion.expectedRect.y),
        Math.abs(fact.rect.width - assertion.expectedRect.width),
        Math.abs(fact.rect.height - assertion.expectedRect.height),
      );
      const failed = maxDeltaCss > assertion.toleranceCss;
      return t3AssertionResult(assertion, failed ? (required ? 'FAIL' : 'WARN') : 'PASS', 'layout-delta', {
        ...metricsBase, ...pixelMetrics, fusion: 'external-facts',
        maxDeltaCss, toleranceCss: assertion.toleranceCss, edgeTouchCount: pixelSignal.metrics.edgeTouchCount ?? null,
      }, { factIds, regions: [roiRegion] });
    }
    if (assertion.type === 'occlusion') {
      if (!fact || !fact.rect || fact.visible === undefined) {
        if (!required) return t3AssertionResult(assertion, pixelSignal.signal === true ? 'WARN' : 'INCONCLUSIVE', 'insufficient-facts', { ...metricsBase, ...pixelMetrics, fusion: 'pixels-only' }, { factIds, regions: [roiRegion] });
        return degraded('insufficient-facts', pixelMetrics);
      }
      if (fact.visible === false) return degraded('invisible', pixelMetrics);
      const samples = Array.isArray(fact.hitSamples) ? fact.hitSamples : [];
      const center = { x: fact.rect.x + fact.rect.width / 2, y: fact.rect.y + fact.rect.height / 2 };
      const unique = new Map();
      let hasCenter = false;
      const quadrants = new Set();
      for (const sample of samples) {
        const key = sample.point.x + ':' + sample.point.y;
        if (unique.has(key)) continue;
        unique.set(key, sample);
        if (sample.point.x < fact.rect.x || sample.point.y < fact.rect.y
          || sample.point.x > fact.rect.x + fact.rect.width || sample.point.y > fact.rect.y + fact.rect.height) continue;
        if (sample.point.x === center.x && sample.point.y === center.y) hasCenter = true;
        quadrants.add((sample.point.x < center.x ? 'l' : 'r') + (sample.point.y < center.y ? 't' : 'b'));
      }
      if (unique.size < 5 || !hasCenter || quadrants.size < 4) {
        if (!required) return t3AssertionResult(assertion, pixelSignal.signal === true ? 'WARN' : 'INCONCLUSIVE', 'insufficient-samples', { ...metricsBase, ...pixelMetrics, fusion: 'pixels-only' }, { factIds, regions: [roiRegion] });
        return degraded('insufficient-samples', pixelMetrics);
      }
      let coveredSamples = 0;
      for (const sample of unique.values()) if (sample.covered === true) coveredSamples += 1;
      const coveredRatio = coveredSamples / unique.size;
      const failed = coveredRatio > assertion.maxCoveredRatio;
      return t3AssertionResult(assertion, failed ? (required ? 'FAIL' : 'WARN') : 'PASS', 'occlusion-ratio', {
        ...metricsBase, ...pixelMetrics, fusion: 'external-facts',
        samples: unique.size, coveredSamples, coveredRatio,
        maxCoveredRatio: assertion.maxCoveredRatio,
        dominantFraction: pixelSignal.metrics.dominantFraction ?? null,
      }, { factIds, regions: [roiRegion] });
    }
    if (assertion.type === 'overflow') {
      if (!fact || !fact.scroll || !fact.style || !fact.style.overflowX || !fact.style.overflowY) {
        if (!required) return t3AssertionResult(assertion, pixelSignal.signal === true ? 'WARN' : 'INCONCLUSIVE', 'insufficient-facts', { ...metricsBase, ...pixelMetrics, fusion: 'pixels-only' }, { factIds, regions: [roiRegion] });
        return degraded('insufficient-facts', pixelMetrics);
      }
      const regionCss = t3RegionDocumentCss(resolved, region);
      if (!regionCss || !t3RectIntersects(fact.rect ?? regionCss, regionCss)) return degraded('fact-region-mismatch', pixelMetrics);
      const overflowXCss = Math.max(0, fact.scroll.scrollWidth - fact.scroll.clientWidth);
      const overflowYCss = Math.max(0, fact.scroll.scrollHeight - fact.scroll.clientHeight);
      const allowOverflow = fact.allowOverflow === true;
      const failX = overflowXCss > assertion.toleranceCss && fact.style.overflowX === 'visible' && !allowOverflow;
      const failY = overflowYCss > assertion.toleranceCss && fact.style.overflowY === 'visible' && !allowOverflow;
      const failed = failX || failY;
      return t3AssertionResult(assertion, failed ? (required ? 'FAIL' : 'WARN') : 'PASS', 'overflow-scroll', {
        ...metricsBase, ...pixelMetrics, fusion: 'external-facts',
        overflowXCss, overflowYCss, toleranceCss: assertion.toleranceCss, allowed: allowOverflow,
        edgeTouchCount: pixelSignal.metrics.edgeTouchCount ?? null,
      }, { factIds, regions: [roiRegion] });
    }
    if (assertion.type === 'truncation') {
      if (!fact || !fact.textMetrics || !fact.style) {
        if (!required) return t3AssertionResult(assertion, pixelSignal.signal === true ? 'WARN' : 'INCONCLUSIVE', 'insufficient-facts', { ...metricsBase, ...pixelMetrics, fusion: 'pixels-only' }, { factIds, regions: [roiRegion] });
        return degraded('insufficient-facts', pixelMetrics);
      }
      const regionCss = t3RegionDocumentCss(resolved, region);
      if (!regionCss || !t3RectIntersects(fact.rect ?? regionCss, regionCss)) return degraded('fact-region-mismatch', pixelMetrics);
      const excessWidthCss = Math.max(0, fact.textMetrics.contentWidth - fact.textMetrics.availableWidth);
      const excessHeightCss = Math.max(0, fact.textMetrics.contentHeight - fact.textMetrics.availableHeight);
      const clipX = ['hidden', 'clip'].includes(fact.style.overflowX);
      const clipY = ['hidden', 'clip'].includes(fact.style.overflowY);
      const lineClamp = Number.isInteger(fact.style.lineClamp) ? fact.style.lineClamp : 0;
      const clipped = (excessWidthCss > assertion.toleranceCss && clipX)
        || (excessHeightCss > assertion.toleranceCss && clipY)
        || (lineClamp > 0 && excessHeightCss > assertion.toleranceCss);
      const allowTruncation = fact.allowTruncation === true;
      return t3AssertionResult(assertion, clipped && !allowTruncation ? (required ? 'FAIL' : 'WARN') : 'PASS', 'truncation-clip', {
        ...metricsBase, ...pixelMetrics, fusion: 'external-facts',
        excessWidthCss, excessHeightCss, clipped, allowed: allowTruncation,
        toleranceCss: assertion.toleranceCss,
        boundaryEdgePixels: pixelSignal.metrics.boundaryEdgePixels ?? null,
      }, { factIds, regions: [roiRegion] });
    }
    if (assertion.type === 'color') {
      const background = t3StyleBackground(fact);
      const pixelMatch = pixelSignal.signal !== null && pixelSignal.signal === false;
      if (!fact || !fact.rect || !background) {
        if (!required) return t3AssertionResult(assertion, pixelSignal.signal === true ? 'WARN' : 'INCONCLUSIVE', 'insufficient-facts', { ...metricsBase, ...pixelMetrics, fusion: 'pixels-only' }, { factIds, regions: [roiRegion] });
        return degraded('insufficient-facts', pixelMetrics);
      }
      const regionCss = t3RegionDocumentCss(resolved, region);
      if (!regionCss) return degraded('mapping-unavailable', pixelMetrics);
      const inside = regionCss.x >= fact.rect.x && regionCss.y >= fact.rect.y
        && regionCss.x + regionCss.width <= fact.rect.x + fact.rect.width
        && regionCss.y + regionCss.height <= fact.rect.y + fact.rect.height;
      if (!inside) return degraded('fact-region-mismatch', pixelMetrics);
      if (background.alpha !== 255) return degraded('transparent-background', pixelMetrics);
      const styleMatches = t3RgbDelta(background.rgba, assertion.expectedColor) <= assertion.tolerance;
      let status;
      let reason;
      if (pixelMatch && styleMatches) { status = 'PASS'; reason = 'color-consistent'; }
      else if (!pixelMatch && !styleMatches) { status = required ? 'FAIL' : 'WARN'; reason = 'color-mismatch'; }
      else { status = 'INCONCLUSIVE'; reason = 'conflicting-signals'; }
      return t3AssertionResult(assertion, status, reason, {
        ...metricsBase, ...pixelMetrics, fusion: 'external-facts',
        sampledPixels: pixelSignal.metrics.sampledPixels,
        matchingPixels: pixelSignal.metrics.matchingPixels,
        matchingFraction: pixelSignal.metrics.matchingFraction,
        minFraction: assertion.minFraction,
        tolerance: assertion.tolerance,
        styleMatches,
      }, { factIds, regions: [roiRegion] });
    }
    // missing
    const presence = fact ? fact.presence : null;
    if (!presence || presence.expected !== true || presence.searchComplete !== true) {
      if (!required) return t3AssertionResult(assertion, pixelSignal.signal === true ? 'WARN' : 'INCONCLUSIVE', 'insufficient-facts', { ...metricsBase, ...pixelMetrics, fusion: 'pixels-only' }, { factIds, regions: [roiRegion] });
      return degraded('insufficient-facts', pixelMetrics);
    }
    const candidateCount = pixelSignal.metrics.candidateCount ?? 0;
    const failed = candidateCount < assertion.minCount && presence.exists === false;
    const passed = candidateCount >= assertion.minCount && presence.exists === true;
    let status;
    let reason;
    if (failed) { status = required ? 'FAIL' : 'WARN'; reason = 'component-missing'; }
    else if (passed) { status = 'PASS'; reason = 'component-present'; }
    else { status = 'INCONCLUSIVE'; reason = 'conflicting-presence'; }
    return t3AssertionResult(assertion, status, reason, {
      ...metricsBase, ...pixelMetrics, fusion: 'external-facts',
      candidateCount, minCount: assertion.minCount,
      expected: presence.expected, exists: presence.exists, searchComplete: presence.searchComplete,
    }, { factIds, regions: [roiRegion] });
  }

  /** Pixel signal for one defect type (advisory-only evidence; never a required conclusion). */
  async function t3PixelSignal(runtime, exec, assertion, image, region, pins, budget, warnings) {
    if (assertion.type === 'layout' || assertion.type === 'overflow') {
      const signal = await t3EdgeTouchSignal(image, region, budget, exec.signal);
      return { signal: signal.edgeTouchCount > 0, metrics: { edgeTouchCount: signal.edgeTouchCount, components: signal.components } };
    }
    if (assertion.type === 'occlusion') {
      const signal = t3OcclusionSignal(image, region);
      return {
        signal: signal.signal,
        metrics: {
          dominantFraction: signal.dominantFraction,
          coveredPixels: signal.coveredPixels,
          roiPixels: signal.roiPixels,
        },
      };
    }
    if (assertion.type === 'truncation') {
      const signal = await t3TruncationSignal(image, region, budget, exec.signal);
      return { signal: signal.signal, metrics: { boundaryEdgePixels: signal.boundaryEdgePixels } };
    }
    if (assertion.type === 'color') {
      const signal = t3ColorSignal(image, region, assertion.expectedColor, assertion.tolerance, assertion.minFraction);
      return {
        signal: signal.signal,
        metrics: {
          sampledPixels: signal.sampledPixels,
          matchingPixels: signal.matchingPixels,
          matchingFraction: signal.matchingFraction,
        },
      };
    }
    const signal = await t3MissingSignal(runtime, exec, image, region, assertion, pins, budget, warnings);
    return { signal: signal.signal, metrics: { candidateCount: signal.candidateCount } };
  }

  /** Regression assertion (§2.7/§8.3): baseline is the before image, case source is after. */
  async function t3RegressionAssertion(runtime, exec, assertion, resolved, pins, budget, warnings) {
    const store = t3BaselineStore(runtime, exec);
    let got;
    try {
      got = assertion.revision === undefined ? store.get(assertion.baseline) : store.get(assertion.baseline, assertion.revision);
    } catch (error) {
      if (error instanceof BrowserError && error.code === 'VISION_BASELINE_NOT_FOUND') {
        return t3AssertionResult(assertion, 'BLOCKED', 'baseline-not-found', { warnings }, { errorCode: 'VISION_BASELINE_NOT_FOUND' });
      }
      throw error;
    }
    const baseline = t3BaselineGetResult(got);
    if (!baseline.meta || !baseline.pngBytes) {
      return t3AssertionResult(assertion, 'BLOCKED', 'baseline-not-found', { warnings }, { errorCode: 'VISION_BASELINE_NOT_FOUND' });
    }
    const beforeBytes = Buffer.isBuffer(baseline.pngBytes) ? baseline.pngBytes : Buffer.from(baseline.pngBytes);
    const beforeDecoded = await t3Decode(beforeBytes, exec.signal, budget);
    const afterImage = resolved.image;
    if (beforeDecoded.width !== afterImage.width || beforeDecoded.height !== afterImage.height) {
      return t3AssertionResult(assertion, 'BLOCKED', 'size-mismatch', {
        before: { width: beforeDecoded.width, height: beforeDecoded.height },
        after: { width: afterImage.width, height: afterImage.height },
        warnings,
      }, { errorCode: 'VISION_SIZE_MISMATCH' });
    }
    const beforeImage = { width: beforeDecoded.width, height: beforeDecoded.height, rgba: beforeDecoded.rgba };
    const beforeMapping = baseline.meta.mapping ?? null;
    const afterMapping = resolved.product ? resolved.product.mapping : null;
    const mappingCompatible = Boolean(beforeMapping && afterMapping && vision.mappingCompatible(beforeMapping, afterMapping));
    if (assertion.severity === 'required' && !mappingCompatible) {
      // §8.3: a missing mapping is "mapping-unavailable"; two incompatible mappings is
      // "mapping-incompatible". Either way no required PASS is claimed and no file is published.
      const reason = !beforeMapping || !afterMapping ? 'mapping-unavailable' : 'mapping-incompatible';
      return t3AssertionResult(assertion, 'BLOCKED', reason, {
        mappingCompatible: false, warnings,
      }, { errorCode: null });
    }
    if (!mappingCompatible) t3Warning(warnings, 'mapping-incompatible');
    const region = assertion.region ?? { x: 0, y: 0, width: afterImage.width, height: afterImage.height };
    if (!t3RegionInsideRoi(region, afterImage)) {
      throw t3Invalid(`regression region 超出图像边界`, { path: `assertions[${assertion.id}].region` });
    }
    let masks = assertion.masks !== undefined ? assertion.masks
      : Array.isArray(baseline.meta.masks) ? baseline.meta.masks : [];
    t3ValidateMaskBounds(masks, afterImage);
    let options = { ...T3_DEFAULT_DIFF_OPTIONS };
    if (baseline.meta.options) options = { ...options, ...baseline.meta.options };
    options = t3MergeResolved(options, assertion.options ?? null, vision.validateDiffOptions, 'options');
    let thresholds = { ...T3_DEFAULT_THRESHOLDS };
    if (baseline.meta.thresholds) thresholds = { ...thresholds, ...baseline.meta.thresholds };
    thresholds = t3MergeResolved(thresholds, assertion.thresholds ?? null, vision.validateThresholds, 'thresholds');
    if (!(thresholds.warnRatio <= thresholds.failRatio)) throw t3Invalid('thresholds 必须满足 0 ≤ warnRatio ≤ failRatio ≤ 1', { path: 'thresholds' });
    const diff = await vision.diffImagesAsync(beforeImage, afterImage, {
      region, masks, options, ...t3AlgoOpts(budget, exec.signal),
    }, t3AlgoOpts(budget, exec.signal));
    if (!diff || !diff.metrics || diff.metrics.comparedPixels === 0) {
      return t3AssertionResult(assertion, 'BLOCKED', 'empty-comparison', { warnings }, { errorCode: 'VISION_EMPTY_COMPARISON' });
    }
    const ratioVerdict = t3RatioVerdict(diff.metrics.diffRatio, thresholds);
    let status = ratioVerdict;
    if (ratioVerdict === 'FAIL' && assertion.severity === 'advisory') status = 'WARN';
    const highlight = Buffer.isBuffer(diff.highlight) ? diff.highlight : Buffer.from(diff.highlight ?? []);
    const diffProduct = t3ProductPublic(t3AddProduct(runtime, {
      bytes: highlight, width: beforeImage.width, height: beforeImage.height, sha256: t3Sha256(highlight),
      rgbaSha256: null, kind: 'diff', mapping: null, actionable: false,
      parentIds: [], operations: [{ op: 'diff', parameters: { resolvedOptions: options, resolvedThresholds: thresholds, resolvedMasks: masks } }],
      capturedAt: null, provenance: t3Provenance(runtime, exec),
    }));
    const metrics = {
      ...diff.metrics,
      resolvedOptions: options,
      resolvedThresholds: thresholds,
      resolvedMasks: masks,
      beforeSha256: t3Sha256(beforeBytes),
      afterSha256: resolved.sha256,
      baselineRevision: baseline.meta.revision,
      headToken: baseline.meta.headToken ?? null,
      mappingCompatible,
      warnings,
    };
    return t3AssertionResult(assertion, status, 'ratio', metrics, {
      diffProductId: diffProduct.productId,
      regions: (Array.isArray(diff.regions) ? diff.regions : []).slice(0, T3_EVIDENCE_REGIONS).map((item) => t3EvidenceRegion({
        id: item.id,
        role: 'diff',
        imagePixels: item.imagePixels ?? item.region ?? null,
        beforeDocumentCss: mappingCompatible && beforeMapping && (item.imagePixels || item.region)
          ? vision.mapImageRectToDocument(beforeMapping, item.imagePixels ?? item.region) : null,
        afterDocumentCss: mappingCompatible && afterMapping && (item.imagePixels || item.region)
          ? vision.mapImageRectToDocument(afterMapping, item.imagePixels ?? item.region) : null,
        area: item.area,
      })),
    });
  }

  async function t3RunAssertion(runtime, exec, testCase, assertion, resolved, factsById, pins, budget, warnings) {
    if (assertion.type === 'regression') {
      return t3RegressionAssertion(runtime, exec, assertion, resolved, pins, budget, warnings);
    }
    return t3DefectAssertion(runtime, exec, testCase, assertion, resolved, factsById, pins, budget, warnings);
  }

  /** Run one case: resolve the source once, run every assertion, release the case pins. */
  async function t3RunCase(runtime, exec, testCase, budget, warnings, liveScale = null) {
    const pins = [];
    const assertionResults = [];
    const incomplete = [];
    let resolved = null;
    const factsById = new Map(testCase.facts.map((fact) => [fact.id, fact]));
    try {
      resolved = await t3ResolveSource(runtime, exec, testCase.source, 'source', pins, budget, liveScale);
      for (const assertion of testCase.assertions) {
        try {
          assertionResults.push(await t3RunAssertion(runtime, exec, testCase, assertion, resolved, factsById, pins, budget, warnings));
        } catch (error) {
          if (error && ['ABORTED', 'CDP_TIMEOUT', 'CDP_DISCONNECTED'].includes(error.code)) throw error;
          assertionResults.push(t3BlockedAssertion(assertion, error));
        }
      }
    } catch (error) {
      if (error && ['ABORTED', 'CDP_TIMEOUT', 'CDP_DISCONNECTED'].includes(error.code)) throw error;
      for (const assertion of testCase.assertions) assertionResults.push(t3BlockedAssertion(assertion, error));
      incomplete.push('source-unavailable');
    } finally {
      t3ReleasePins(runtime, pins);
    }
    return {
      result: {
        id: testCase.id,
        sourceProductId: resolved && resolved.product ? resolved.product.productId : null,
        assertions: assertionResults,
        verdict: t3Verdict(assertionResults.map((item) => item.status)),
        incomplete,
      },
      source: resolved ? t3EvidenceSource(resolved, 'source') : null,
    };
  }

  register({
    name: 'browser_vision_check',
    description: 'T3 静态视觉回归/缺陷用例集：cases 1–20，每 case 1–32 assertions、0–64 facts，整批先做纯参数校验再逐 case 执行。'
      + 'assertion.type=regression（与基线比较，不发布文件）或 layout/occlusion/overflow/truncation/color/missing（像素信号 + 调用方显式提供的外部事实融合）。'
      + 'required 缺必需事实/来源不匹配返回 INCONCLUSIVE/BLOCKED，advisory 最多 WARN；regression 需兼容 mapping，baseline 缺失为 BLOCKED。'
      + '返回 summary/verdict/exitCode（FAIL→1，无 FAIL 但 BLOCKED/INCONCLUSIVE→2，PASS/WARN→0），不调用 process.exit。'
      + '不导航、不建/更新基线、不读 DOM（facts 由调用方提供并标记 trusted=false）。',
    parameters: {
      type: 'object',
      additionalProperties: false,
      required: ['cases'],
      properties: {
        cases: {
          type: 'array',
          description: 'Case[]（1–20）：{id, source, assertions[1–32], facts?[0–64]}。',
          minItems: 1,
          maxItems: 20,
          items: { type: 'object' },
        },
      },
    },
    output: { schema: { type: 'object' }, render: (args, value) => text(value) },
    async execute(args, exec) {
      const runtime = exec.runtime;
      const provenance = t3Provenance(runtime, exec);
      const budget = t3NewBudget();
      const warnings = [];
      const caseResults = [];
      const evidenceSources = [];
      const evidenceFacts = [];
      let request = null;
      try {
        request = t3CheckRequest(args && typeof args === 'object' ? args : {});
        // One frozen default scale for every case of this call.
        const liveScale = runtime.view.scale;
        for (const testCase of request) {
          const { result, source } = await t3RunCase(runtime, exec, testCase, budget, warnings, liveScale);
          caseResults.push(result);
          if (source && !evidenceSources.some((entry) => entry.productId === source.productId)) {
            evidenceSources.push(source);
          }
          for (const fact of testCase.facts) {
            evidenceFacts.push({
              id: fact.id,
              sourceActionId: fact.provenance.sourceActionId,
              observedAt: fact.provenance.observedAt,
              documentEpoch: fact.provenance.documentEpoch,
              trusted: false,
            });
          }
        }
        const summary = { pass: 0, warn: 0, fail: 0, inconclusive: 0, blocked: 0 };
        for (const result of caseResults) {
          for (const assertion of result.assertions) {
            if (assertion.status === 'PASS') summary.pass += 1;
            else if (assertion.status === 'WARN') summary.warn += 1;
            else if (assertion.status === 'FAIL') summary.fail += 1;
            else if (assertion.status === 'BLOCKED') summary.blocked += 1;
            else summary.inconclusive += 1;
          }
        }
        let verdict = t3Verdict(caseResults.map((result) => result.verdict));
        let exitCode = verdict === 'FAIL' ? 1 : (verdict === 'BLOCKED' || verdict === 'INCONCLUSIVE') ? 2 : 0;
        const evidenceRegions = [];
        for (const result of caseResults) {
          for (const assertion of result.assertions) {
            for (const region of assertion.regions) evidenceRegions.push(region);
          }
        }
        const evidence = t3Evidence({
          operation: 'check',
          provenance,
          source: evidenceSources,
          regions: evidenceRegions.slice(0, T3_EVIDENCE_REGIONS),
          metrics: { summary, caseCount: caseResults.length, assertionCount: summary.pass + summary.warn + summary.fail + summary.inconclusive + summary.blocked, warnings },
          facts: evidenceFacts,
          verdict: { status: verdict, reason: 'summary' },
          incomplete: caseResults.some((result) => result.incomplete.length > 0) ? ['case-incomplete'] : [],
        });
        t3BoundEvidence(evidence);
        if (evidence.truncated && verdict === 'PASS') {
          // Truncated evidence cannot support an unqualified PASS (contract §3.2).
          verdict = 'INCONCLUSIVE';
          exitCode = 2;
          evidence.verdict = { status: verdict, reason: 'evidence-truncated' };
          evidence.incomplete = [...evidence.incomplete, 'evidence-truncated'];
        }
        runtime.noteVisionOperation('check', verdict);
        return {
          ok: true,
          cases: caseResults,
          summary,
          verdict,
          exitCode,
          evidence: { vision: evidence },
        };
      } catch (error) {
        const evidence = t3Evidence({
          operation: 'check',
          provenance,
          source: evidenceSources,
          verdict: { status: 'BLOCKED', reason: 'error' },
          metrics: {
            errorCode: error && error.code ? error.code : 'INTERNAL',
            completedCases: caseResults.length,
            warnings,
          },
          facts: evidenceFacts,
          incomplete: ['operation-failed'],
        });
        runtime.noteVisionOperation('check', null);
        const thrown = t3ThrowWithEvidence(error, evidence);
        // ABORTED / CDP disconnect / queue timeout: the already-finished cases travel with the
        // original error (they are not re-judged and no further evidence is collected).
        thrown.details = {
          ...thrown.details,
          completedCases: caseResults.map((result) => ({
            id: result.id,
            verdict: result.verdict,
            assertions: result.assertions.map((assertion) => ({
              id: assertion.id, type: assertion.type, severity: assertion.severity,
              status: assertion.status, reason: assertion.reason, errorCode: assertion.errorCode,
            })),
          })),
        };
        throw thrown;
      }
    },
  });

  register({
    name: 'browser_capabilities',
    description: '查询 Web T1/T2/T3/P0 工具、运行态、隔离模式及证据限制；不会启动浏览器（不 ensure、不建目录、不生成 product、不申请租约）。'
      + 'viewport 段报告共享视口 get/set 边界、预设、比例范围与 limits.viewport（observed 只来自真实读回）；'
      + 'vision 段报告 T3 算法版本/工具/源类型/预算与最近一次真实视觉调用（observed），六个 web.t3.* 与聚合 web.t3.static-vision 按 BUSY 状态报告；'
      + 'network 段报告 7 个 browser_network_* 工具、会话计数器/完整性与 limits.network（含 responseModification 是否受 CDP 支持）；T4 仍 unsupported。',
    parameters: { type: 'object', properties: {}, required: [] },
    output: { schema: { type: 'object' }, render: (args, value) => text(value) },
    async execute(args, exec) {
      const runtime = exec.runtime;
      const running = Boolean(runtime.cdp && !runtime.cdp.closed);
      const owner = runtime.state().owner.sessionId;
      const busy = owner && owner !== exec.meta.sessionId;
      const pageTools = ['navigate', 'eval', 'screenshot', 'input', 'network', 'computed_style'];
      // T2 surface: snapshot + the six structured actions. All of them are page operations (lazy
      // start, serial queue, single-owner lease) and all of them return structured evidence.
      const t2Tools = ['snapshot', 'click', 'type', 'scroll', 'fill_form', 'node_state', 'wait_for'];
      // T3 surface: six static-vision tools. All of them enter the scope queue and the owner check
      // (offline baseline list/get/delete included); only a live source or `act` starts a page.
      const t3Tools = ['vision_image', 'vision_find', 'vision_compare', 'vision_act', 'vision_baseline', 'vision_check'];
      const t3CapabilityIds = ['web.t3.image', 'web.t3.find', 'web.t3.compare', 'web.t3.act', 'web.t3.baseline', 'web.t3.check'];
      const diagnosticTools = ['state', 'capabilities'];
      // Web P0 network surface (docs/network-p0.md §8.8). Read-only actions stay available even when
      // another session owns the page; `session` mutations and page-bound `control` actions report
      // unavailable(BUSY) like every other page operation.
      const networkTools = ['session', 'events', 'detail', 'trace', 'control', 'evidence', 'subscribe'];
      const networkConstraints = [
        'declared, never probed: reading this starts no Chromium and takes no lease',
        'session.start is the only lazy-start action; status/reset, events, detail, trace reads, evidence and subscribe never start a page',
        'collector is per workspace scope (events/bodies/steps/links/artifacts/subscriptions)',
        'G1.5 iframe/OOPIF/worker coverage is partial: popups stay blocked and shared/service workers are refused when attribution cannot be proven',
        'not a MITM proxy: no CA install, no TLS key reading, no cookie export',
      ];
      const pageConstraints = ['page tools lazily start Chromium; startup may fail', 'single owner lease; shared page with panel'];
      const t2Constraints = [
        'structured DOM/AX tier: refs come from browser_snapshot; numbers are monotonic, never reused, LRU-capped at ' + T2_LIMITS.maxRefs,
        'A newer snapshot does NOT invalidate older refs; a document commit, main-context loss or close clears them (REF_STALE)',
        'Trusted CDP input for click/type/form booleans; native select/range writes report eventSource=dom-control',
        'Every action returns version=1 structured evidence; no force/JS-click escape hatch and no pixel/visual judgement (T3)',
      ];
      const t3Constraints = [
        'static vision only: PNG processing, deterministic recognition, pixel diff and coordinate input; no VLM/OCR/semantic naming',
        'sources are live capture / this scope product / managed baseline; no arbitrary path, URL, attachment id or caller base64',
        'products are per workspace scope (16 images, 128 MiB total); page navigation keeps images readable but invalidates act',
        'one delivered PNG per call under the P0 output rules (staging by default, 0600, no-clobber); evidence.vision.version=1',
        'offline baseline list/get/delete and product sources never start Chromium; live sources and act do',
        'T4 dynamic vision (frame sequences/animation timing) stays unsupported',
      ];
      const diagnosticConstraints = ['diagnostic call; never starts Chromium or takes ownership'];
      const viewportConstraints = [
        'one shared view per workspace scope: {x,y,width,height,scale,source,revision} in document CSS px',
        'get is a cache diagnostic: no lazy start, no CDP, no lease, no queue; an older cache is reported stale',
        'set is a page operation (lazy start + serial queue + single-owner lease), including a scale-only set',
        'only a width/height change sends Emulation.setDeviceMetricsOverride; scale never changes CSS viewport, DPR or page zoom',
        'expectedRevision gives CAS inside the queue (VIEWPORT_CONFLICT, patch not applied)',
        'x/y are the document scroll position read back from Page.getLayoutMetrics (not cached page values)',
      ];
      const workspaceIsolation = registry.capabilities();
      // P0 capture facts. `observed` only ever comes from a real browser_screenshot of this Runtime
      // (relative paths and numbers only) — this call still starts nothing and takes no lease.
      const observation = runtime.captureObservation;
      // T3 observation: the last real vision call of this Runtime (status/numbers only).
      const visionObservation = runtime.visionObservation;
      const observedCapture = observation && typeof observation === 'object'
        ? {
          observedAt: observation.observedAt,
          scale: observation.scale,
          png: { width: observation.png.width, height: observation.png.height },
          sizeCheck: { ok: observation.sizeCheck.ok === true },
          anomaly: {
            checked: observation.anomaly.checked === true,
            uniform: typeof observation.anomaly.uniform === 'boolean' ? observation.anomaly.uniform : null,
            transparent: typeof observation.anomaly.transparent === 'boolean' ? observation.anomaly.transparent : null,
          },
          delivery: { downscaled: observation.delivery.downscaled === true },
          file: observation.file
            ? { persistence: observation.file.persistence, relativePath: observation.file.relativePath }
            : null,
        }
        : null;
      return { ok: true,
        runtime: {
          running, browser: 'chromium', transport: running ? 'ws' : 'unavailable',
          isolation: 'single-owner-lease', attachments: typeof attachments?.saveImage === 'function',
          scope: runtime.scope,
          // Page-per-workspace isolation only: the Chromium process and the temporary profile
          // (hence cookies/localStorage/cache) are shared. This is not a security boundary.
          workspaceIsolation,
        },
        capabilities: [
          ...pageTools.map((name) => ({ id: 'web.t1.' + name, tool: 'browser_' + name,
            status: busy ? 'unavailable' : 'available',
            ...(busy ? { reason: 'BUSY: browser owned by another session' } : {}),
            constraints: pageConstraints })),
          ...t2Tools.map((name) => ({ id: 'web.t2.' + name, tool: 'browser_' + name,
            status: busy ? 'unavailable' : 'available',
            ...(busy ? { reason: 'BUSY: browser owned by another session' } : {}),
            constraints: t2Constraints })),
          ...t3Tools.map((name, index) => ({ id: t3CapabilityIds[index], tool: 'browser_' + name,
            status: busy ? 'unavailable' : 'available',
            ...(busy ? { reason: 'BUSY: browser owned by another session' } : {}),
            constraints: t3Constraints })),
          ...diagnosticTools.map((name) => ({ id: 'web.t1.' + name, tool: 'browser_' + name, status: 'available', constraints: diagnosticConstraints })),
          // Shared viewport (docs/viewport-control.md §7.2): get stays readable even when another
          // session owns the page; set is a page operation and reports BUSY like every other one.
          { id: 'web.t1.viewport', tool: 'browser_viewport',
            status: busy ? 'unavailable' : 'available',
            ...(busy ? { reason: 'BUSY: browser owned by another session (get 仍可只读诊断)' } : {}),
            constraints: viewportConstraints },
          { id: 'web.t1.workspace-isolation', status: 'available',
            constraints: [
              'One headless Chromium + temporary profile for the plugin; one independent page target per workspace',
              'Isolated per page: URL/title/history, viewport, frame source, network buffer, queue, lease, error, metrics',
              'NOT isolated: cookies, localStorage and cache are shared inside the single profile',
              'At most ' + workspaceIsolation.maxPages + ' page instances; idle ' + workspaceIsolation.idleMs + 'ms sweep; RUNTIME_LIMIT when full',
            ] },
          { id: 'web.t1.http-request', tool: 'browser_http_request', status: 'available',
            constraints: [
              'Host HTTP(S) client; no Chromium startup, page queue or owner lease',
              'No cookie jar or page credentials; caller headers are explicit',
              'Target URLs and DNS checked before every dispatch; redirects are manual and opt-in',
              'Response bytes are bounded; body may be truncated; no automatic decompression',
            ] },
          { id: 'web.t2.structured-dom',
            status: busy ? 'unavailable' : 'available',
            ...(busy ? { reason: 'BUSY: browser owned by another session' } : {}),
            constraints: [
              'Accessibility.getFullAXTree + DOM identity: snapshot -> ref -> action -> before/after evidence',
              'Targets are the two exclusive plain strings ref / selector; selector must be unique in the main document',
              'AX-backed refs reach open shadow roots; iframes are boundary leaves only (no internal ref)',
              'Form support: textbox/checkbox/radio via trusted CDP input, combobox/slider via native setters (dom-control)',
              'No visual/pixel judgement: layout, occlusion cause or visual readability still needs T3; motion needs T4',
            ] },
          { id: 'web.t3.static-vision',
            status: busy ? 'unavailable' : 'available',
            ...(busy ? { reason: 'BUSY: browser owned by another session' } : {}),
            constraints: t3Constraints },
          ...networkTools.map((name) => {
            const mutating = name === 'session' || name === 'control';
            const blocked = mutating && busy;
            return {
              id: 'web.network.' + name,
              tool: 'browser_network_' + name,
              status: blocked ? 'unavailable' : 'available',
              ...(blocked ? { reason: 'BUSY: browser owned by another session' } : {}),
              constraints: networkConstraints,
            };
          }),
          { id: 'web.network.p0',
            status: busy ? 'unavailable' : 'available',
            ...(busy ? { reason: 'BUSY: browser owned by another session' } : {}),
            constraints: [
              ...networkConstraints,
              'partial: iframe/OOPIF/dedicated worker only; shared/service worker refused when attribution is unprovable',
              'HTTPS capture is mechanism-identical (same Network domain) but NOT independently verified (no local TLS target)',
            ] },
          ...['t4.dynamic-vision', 't1.browser-extras'].map((id) => ({ id: 'web.' + id, status: 'unsupported', reason: 'Not implemented' })),
        ],
        // P0 capture infrastructure (docs/capture-p0.md). Declared, not probed: reading this must
        // never start Chromium, create a page or take the lease. `observed` is the last real
        // browser_screenshot of this Runtime (null until one succeeded).
        capture: {
          version: 1,
          transport: 'cdp-page-capture-screenshot',
          format: 'png',
          coordinateSpace: 'document-css-px',
          // An omitted scale is resolved from the shared view.scale inside the call, so `defaultScale`
          // is the cold fallback (1) and NOT the lower bound of the legal range.
          defaultScaleSource: 'view.scale',
          defaultScale: VIEW_LIMITS.default.scale,
          scaleRange: [CAPTURE_LIMITS.scaleMin, CAPTURE_LIMITS.scaleMax],
          viewScaleRange: [...VIEW_LIMITS.scale],
          maxOutputPixels: CAPTURE_LIMITS.maxOutputPixels,
          supports: {
            region: true,
            clipScale: true,
            captureBeyondViewport: true,
            pngStructureCheck: true,
            blankCheck: true,
            fileWrite: true,
            noClobber: true,
            attachmentSizeCompare: true,
          },
          output: {
            persistRules: [...CAPTURE_PERSIST_RULES],
            defaultMode: 'staging',
            stagingRoot: '<tmp>/dsh-ui-testing-capture-*',
            workspaceRoot: '<workspace>',
            directory: 'output/capture',
            env: 'DSH_UI_TESTING_CAPTURE_DIR',
            mode: '0600',
            noClobber: true,
            ephemeral: true,
          },
          limits: { maxRegionPixels: CAPTURE_LIMITS.maxOutputPixels },
          observed: observedCapture,
        },
        // Shared viewport (docs/viewport-control.md §7.2). Declared, never probed: reading this
        // starts nothing and takes no lease. `observed` only comes from a real Page.getLayoutMetrics
        // readback (numbers only, no page text, no absolute path).
        viewport: {
          version: 1,
          tool: 'browser_viewport',
          coordinateSpace: 'document-css-px',
          get: { readOnly: true, lazyStart: false, lease: false, fresh: false },
          set: { lazyStart: true, lease: true },
          deviceScaleFactor: 1,
          pageZoomChanged: false,
          presets: Object.fromEntries(Object.entries(VIEW_PRESETS).map(([mode, size]) => [mode, { ...size }])),
          default: { ...VIEW_LIMITS.default },
          scaleRange: [...VIEW_LIMITS.scale],
          observed: (() => {
            const observed = runtime.observedProjection();
            return observed === null ? null : {
              revision: runtime.view.revision,
              source: runtime.view.source,
              observedAt: observed.observedAt,
              stale: runtime.viewMeta().stale,
            };
          })(),
        },
        // Web T3 static vision (docs/t3-vision.md §11). Declared, never probed: reading this must
        // not start Chromium, create the baseline root or add a product. `observed` is the last real
        // vision call of this Runtime and never contains an image, an absolute path or page text.
        vision: {
          version: 1,
          algorithmVersion: T3_ALGORITHM_VERSION,
          tools: [...T3_TOOL_NAMES],
          sourceKinds: [...T3_SOURCE_KINDS],
          limits: {
            maxProducts: T3_LIMITS.maxProducts,
            maxTotalBytes: T3_LIMITS.maxTotalBytes,
            maxProductBytes: T3_LIMITS.maxProductBytes,
            maxProductPixels: T3_LIMITS.maxProductPixels,
            maxWorkingSetBytes: T3_LIMITS.maxWorkingSetBytes,
            maxTemplateComparisons: T3_LIMITS.maxTemplateComparisons,
            algorithmBudgetMs: T3_LIMITS.algorithmBudgetMs,
            maxOutputPixels: T3_LIMITS.maxOutputPixels,
            maxOutputBytes: T3_LIMITS.maxOutputBytes,
            maxEvidenceBytes: T3_EVIDENCE_BYTES,
            maxEvidenceRegions: T3_EVIDENCE_REGIONS,
            maxCases: T3_MAX_CASES,
            maxAssertionsPerCase: T3_MAX_ASSERTIONS,
            maxFactsPerCase: T3_MAX_FACTS,
            maxMasks: T3_MAX_MASKS,
            maxAnnotations: T3_MAX_ANNOTATIONS,
            maxPreprocess: T3_MAX_PREPROCESS,
            actMaxAgeMs: T3_ACT_MAX_AGE_MS,
          },
          observed: visionObservation && typeof visionObservation === 'object'
            ? {
              observedAt: visionObservation.observedAt,
              lastOperation: typeof visionObservation.lastOperation === 'string' ? visionObservation.lastOperation : null,
              lastVerdict: typeof visionObservation.lastVerdict === 'string' ? visionObservation.lastVerdict : null,
            }
            : null,
        },
        // Web P0 network (docs/network-p0.md §8.8). Declared, never probed.
        network: (() => {
          const caps = network.networkCapabilities(runtime.net, { control: runtime.netCtl, subTargets: NETWORK_SUBTARGETS });
          return {
            ...caps,
            session: busy && runtime.net.session
              ? { ...caps.session, state: caps.session.state }
              : caps.session,
          };
        })(),
        limits: {
          viewport: {
            ...runtime.viewport,
            version: 1,
            width: [...VIEW_LIMITS.width],
            height: [...VIEW_LIMITS.height],
            scroll: [...VIEW_LIMITS.scroll],
            scale: [...VIEW_LIMITS.scale],
            default: { ...VIEW_LIMITS.default },
            presets: Object.fromEntries(Object.entries(VIEW_PRESETS).map(([mode, size]) => [mode, { ...size }])),
            scrollPollMinMs: VIEW_LIMITS.scrollPollMinMs,
            staleAfterMs: VIEW_LIMITS.staleAfterMs,
            settleMaxMs: VIEW_LIMITS.settleMaxMs,
            deviceScaleFactor: 1,
            pageZoomChanged: false,
          },
          networkEntries: NETWORK_LIMIT,
          network: {
        ...network.limitsView(),
        availability: 'declared',
        // §8.8 capability flags (booleans) + numeric bounds in the *Limits objects.
        capture: true, bodies: true, websocket: true, sse: true, workers: true,
        interception: true, throttle: true, offline: true, replay: true, mock: true,
        har: true, jsonl: true, subscriptions: true,
        https: 'mechanism-identical',
        responseModification: runtime.netCtl.responseModification === true,
        subTargets: NETWORK_SUBTARGETS,
        throttleLimits: { latencyMsMax: 60000, downloadKbpsMax: 1000000, uploadKbpsMax: 1000000, unit: 'Kbps = 1024 bit/s' },
        holdLimits: { maxHeld: network.NET_LIMITS.held, timeoutMs: network.NET_LIMITS.holdTimeoutMs },
        ruleLimits: { max: network.NET_LIMITS.rules, kinds: [...network.NET_RULE_KINDS] },
        subTargetsDetail: {
          // Measured on this build (real headless Chromium + /web-network.html):
          //  - dedicated worker: attached at the page level, requests captured with their own targetId
          //  - service worker: NOT attached — a page-level attach pauses it at start
          //    (waitForDebuggerOnStart) and makes `serviceWorker.register()`/`controller` fail, i.e.
          //    collection would change page semantics, so it is refused by design.
          //  - shared worker: page-level attach entry is armed, but this build attaches nothing
          //    observable for it (the fixture's `/n/worker-data` stays uncaptured).
          //  - OOPIF: same-origin iframe target captured; cross-site OOPIF is NOT separately verified.
          workers: 'page-attached',
          shared_worker: 'not-collected',
          service_worker: 'not-collected',
          oopif: 'partial',
          partial: true,
          reason: 'attaching a service_worker target pauses it at start and breaks serviceWorker.register()/controller, so it is refused; popup targets stay blocked; cross-site OOPIF not separately verified',
        },
      },
          screenshot: typeof attachments?.saveImage === 'function' ? 'attachment' : 'base64-fallback',
          leaseIdleMs: AGENT_HOLD_MS,
          scope: { id: runtime.scope.id, workspaceId: runtime.scope.workspaceId, degraded: runtime.scope.degraded },
          workspaceIsolation,
          capture: {
            scaleRange: [CAPTURE_LIMITS.scaleMin, CAPTURE_LIMITS.scaleMax],
            defaultScaleSource: 'view.scale',
            defaultScale: VIEW_LIMITS.default.scale,
            scale: 'explicit: continuous 0.1-4 (fractions allowed); omitted: the shared view.scale; output = round(css x scale)',
            minOutputPixels: { width: CAPTURE_LIMITS.minOutputPixels, height: CAPTURE_LIMITS.minOutputPixels },
            maxOutputPixels: CAPTURE_LIMITS.maxOutputPixels,
            maxRegionPixels: CAPTURE_LIMITS.maxOutputPixels,
            maxPathBytes: 200,
            maxSegmentBytes: 100,
            extension: '.png',
            fileMode: '0600',
            noClobber: true,
            staging: true,
            persistParam: true,
            pathKind: ['relative', 'absolute'],
            persistRules: [...CAPTURE_PERSIST_RULES],
            defaultName: 'output/capture/<actionId>.png',
            env: 'DSH_UI_TESTING_CAPTURE_DIR',
            warnings: [...CAPTURE_WARNING_VOCABULARY],
          },
          vision: {
            algorithmVersion: T3_ALGORITHM_VERSION,
            coordinateSpaces: { image: 'image-px', document: 'document-css-px', input: 'viewport-css-px' },
            sourceKinds: [...T3_SOURCE_KINDS],
            productIdPattern: '^v1_[0-9a-f]{32}$',
            productKinds: ['capture', 'derived', 'diff', 'baseline'],
            maxProducts: T3_LIMITS.maxProducts,
            maxTotalBytes: T3_LIMITS.maxTotalBytes,
            maxProductBytes: T3_LIMITS.maxProductBytes,
            maxProductPixels: T3_LIMITS.maxProductPixels,
            algorithmBudgetMs: T3_LIMITS.algorithmBudgetMs,
            maxTemplateComparisons: T3_LIMITS.maxTemplateComparisons,
            evidence: { version: 1, maxBytes: T3_EVIDENCE_BYTES, maxRegions: T3_EVIDENCE_REGIONS },
            check: { maxCases: T3_MAX_CASES, maxAssertions: T3_MAX_ASSERTIONS, maxFacts: T3_MAX_FACTS },
            masks: T3_MAX_MASKS,
            annotations: T3_MAX_ANNOTATIONS,
            preprocess: T3_MAX_PREPROCESS,
            act: { maxAgeMs: T3_ACT_MAX_AGE_MS, actions: ['move', 'click', 'drag'] },
            warnings: [...T3_WARNING_VOCABULARY],
            diff: { algorithm: 'yiq-v1', defaultOptions: { ...T3_DEFAULT_DIFF_OPTIONS }, defaultThresholds: { ...T3_DEFAULT_THRESHOLDS } },
            baseline: { root: 'DSH_UI_TESTING_CAPTURE_DIR | workspace', scopeHash: 'sha256(scopeId).slice(0,32)', directory: 'output/vision-baselines', mode: { directory: '0700', file: '0600' }, actions: ['list', 'get', 'create', 'update', 'delete'] },
            observed: visionObservation && typeof visionObservation === 'object'
              ? {
                observedAt: visionObservation.observedAt,
                lastOperation: typeof visionObservation.lastOperation === 'string' ? visionObservation.lastOperation : null,
                lastVerdict: typeof visionObservation.lastVerdict === 'string' ? visionObservation.lastVerdict : null,
              }
              : null,
            notImplemented: ['T4 dynamic vision: frame sequences, animation timing, continuous visual reasoning'],
          },
          navigation: 'Document URLs and DNS checked; subresources are not a network sandbox',
          structuredGui: {
            protocolVersion: T2_LIMITS.protocolVersion,
            targetFrame: 'main',
            defaultMaxNodes: T2_LIMITS.snapshotDefaultMaxNodes,
            maxNodes: T2_LIMITS.snapshotMaxNodes,
            defaultDepth: T2_LIMITS.snapshotDefaultDepth,
            maxDepth: T2_LIMITS.snapshotMaxDepth,
            boxesDefault: false,
            treeBytes: T2_LIMITS.treeBytes,
            snapshotBytes: T2_LIMITS.snapshotBytes,
            evidenceBytes: T2_LIMITS.evidenceBytes,
            maxRefs: T2_LIMITS.maxRefs,
            refPolicy: 'monotonic-lru',
            formFields: T2_LIMITS.formFields,
            textBytes: T2_LIMITS.formTextBytes,
            formKinds: [...T2_FORM_KINDS],
            scrollAmount: T2_LIMITS.scrollAmount,
            wait: {
              defaultTimeoutMs: T2_LIMITS.waitDefaultTimeoutMs,
              maxTimeoutMs: T2_LIMITS.waitMaxTimeoutMs,
              defaultPollMs: T2_LIMITS.waitDefaultPollMs,
              minPollMs: T2_LIMITS.waitMinPollMs,
              maxPollMs: T2_LIMITS.waitMaxPollMs,
            },
            refLifecycle: 'monotonic refs, LRU 2000; cleared on a main-frame document commit, main-context loss, close and CDP disconnect; same-document pushState/hash keeps refs',
            selectors: 'unique CSS in the main document only; no shadow pierce, no iframe, no XPath/text DSL',
            shadow: 'AX-backed refs reach open shadow roots; hit-test walks open roots',
            iframes: 'boundary-only: the iframe element can be inspected, actions inside it are UNSUPPORTED',
            formControls: 'textbox/checkbox/radio via CDP input; combobox/slider via native setters (dom-control, never isTrusted)',
            noForce: 'no force/JS-click/selector-retry escape hatch; occlusion or instability is a reported failure',
            evidence: 'version=1; editable values and input text are never echoed (value null + valueRedacted)',
            visual: 'no pixel/visual analysis in this tier: T3 static vision and T4 dynamic vision stay unsupported',
            cookies: 'shared with the single Chromium profile (not a security boundary)',
          },
          httpRequest: {
            defaultTimeoutMs: HTTP_DEFAULTS.timeoutMs,
            maxTimeoutMs: HTTP_LIMITS.timeoutMsMax,
            defaultMaxBytes: HTTP_DEFAULTS.maxBytes,
            maxBytes: HTTP_LIMITS.maxBytesMax,
            maxRequestBodyBytes: HTTP_LIMITS.bodyBytes,
            maxRequestHeaderBytes: HTTP_LIMITS.requestHeaderBytes,
            maxResponseHeaderBytes: HTTP_LIMITS.responseHeaderBytes,
            followRedirects: HTTP_DEFAULTS.followRedirects,
            defaultMaxRedirects: HTTP_DEFAULTS.maxRedirects,
            maxRedirects: HTTP_LIMITS.maxRedirectsMax,
            cookies: 'none; no cookie jar or page credentials',
            isolation: 'independent requests; no shared page lease or queue',
            targetPolicy: 'HTTP(S), URL and DNS validation per dispatch; loopback allowed; private ranges require DSH_UI_TESTING_ALLOW_PRIVATE=1; known DSH origins blocked',
            security: 'Not a complete network sandbox; DNS rebinding remains possible; unknown host origins and response content may contain secrets',
          },
        },
      };
    },
  });
  // Returned for the fake-ctx acceptance harness only (Cordis ignores apply()'s return value);
  // production callers must keep using the HTTP/tool surface, not this handle.
  return { registry };
}
