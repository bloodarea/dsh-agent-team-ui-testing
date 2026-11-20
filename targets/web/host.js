/**
 * Web environment runtime — the platform implementation behind the public Host.
 *
 * Everything that is only true of a real Chromium page lives here: the browser process
 * (`BrowserHost`), one page runtime with its CDP session (`Runtime`), the page registry with the
 * single-owner lease, workspace page groups, popup bookkeeping and the P0-E projections
 * (`RuntimeRegistry`), the independent HTTP client, the lazy Web-only module chain
 * (`ensureWebHostModules`), the T2 accessibility projection, annotation document validation,
 * capture request normalisation, view presets and element picking.
 *
 * Dependency direction: `core/`, `browser-safety.js`, `select-control.js` and its own sibling
 * modules only. It never imports `index.js`, `integration/` or another target. The Host assembles
 * the environment and injects what the runtime needs: the Cordis context for page services, the
 * host-service lookup used by the roster check, and the P0-E tab limits.
 */
import { execFileSync, spawn } from 'node:child_process';
import { accessSync, constants as fsConstants, mkdirSync, readFileSync, statSync, unlinkSync } from 'node:fs';
import { mkdtemp, readFile, realpath, rm } from 'node:fs/promises';
import { homedir, tmpdir } from 'node:os';
import { delimiter, extname, join, sep, isAbsolute } from 'node:path';
import { fileURLToPath } from 'node:url';
import { createHash, randomUUID } from 'node:crypto';
import http from 'node:http';
import https from 'node:https';
import net from 'node:net';
import { performance } from 'node:perf_hooks';

import {
  abortable, asBrowserError, BrowserError, Cdp, checkAbort, redactText, redactUrl, validateTarget,
} from '../../browser-safety.js';
import { classifySelectWrite, normalizeSelectProjection, selectProbeDeclaration, selectWriteExpression } from '../../select-control.js';
import { WEB_PROVIDER_REASONS } from '../../core/contracts.js';
import { resolveProviderExecutable, verifyProviderProduct } from './adapter.js';
import {
  AUTHORIZE_REASON, CONTROL_EVENT, CONTROL_STATE, EFFECT, PAGE_GROUP_KEY_PREFIX, RESOURCE,
  applyControlTransition, authorize, makeActorSelectionKey, makeControl, makePageAccess,
  makePageGroupKey, makePageTargetKey, parsePageGroupKey, projectPermissions,
} from '../../core/index.js';

export const WEB_HOST_MODULE_SPECS = Object.freeze({
  'frame-source': '../../frame-source.js',
  'audio-source': './audio-source.js',
  'audio-tap': './audio-tap.js',
  'capture-p0': '../../capture-p0.js',
  'annotation-capture': '../../annotation-capture.js',
  'vision-t3': '../../vision-t3.js',
  'vision-baseline': '../../vision-baseline.js',
  'network-p0': '../../network-p0.js',
  'cookie-store': '../../cookie-store.js',
  'security-scope': '../../security-scope.js',
  'attack-surface': '../../attack-surface.js',
  'script-analysis': '../../script-analysis.js',
  'runtime-debug': '../../runtime-debug.js',
  'finding': '../../finding.js',
  'security-rules': '../../security-rules.js',
  'business-logic': '../../business-logic.js',
});

export const webHostModules = { loaded: false, loading: null, namespaces: {}, failed: null };

/** Resolved namespace, or a typed "not loaded" view when the Web chain was never demanded. */

/** Resolved namespace, or a typed "not loaded" view when the Web chain was never demanded. */
export function webHostNamespace(id) {
  const namespace = webHostModules.namespaces[id];
  if (namespace) return namespace;
  return null;
}

/**
 * Load every Web-only module once. Safe to call from any concurrency: callers share one promise.
 *
 * This is the *only* place the Web dependency chain is resolved, so a host that never enables the
 * Web environment (or never touches a page) never loads it.
 */

/**
 * Read-only facts about the Web-only module chain (diagnostics/tests only).
 *
 * `loaded === false` is the observable form of "this host never paid for the Web dependency
 * chain" (plan §2 完成条件：Web 禁用时零浏览器启动、零 Web 执行模块加载). It never triggers a load.
 */
export function webHostModuleFacts() {
  return {
    loaded: webHostModules.loaded === true,
    failed: webHostModules.failed ?? null,
    namespaces: Object.keys(webHostModules.namespaces),
  };
}

export async function ensureWebHostModules() {
  if (webHostModules.loaded) return webHostModules.namespaces;
  if (webHostModules.loading) return webHostModules.loading;
  webHostModules.loading = (async () => {
    const entries = Object.entries(WEB_HOST_MODULE_SPECS);
    const loaded = await Promise.all(entries.map(([, specifier]) => import(specifier)));
    entries.forEach(([id], index) => { webHostModules.namespaces[id] = loaded[index]; });
    webHostModules.loaded = true;
    return webHostModules.namespaces;
  })();
  try {
    return await webHostModules.loading;
  } catch (error) {
    webHostModules.loading = null;
    webHostModules.failed = String((error && error.message) || error);
    throw new BrowserError('ADAPTER_DISABLED', 'Web 专用模块加载失败：' + webHostModules.failed, {
      module: Object.keys(WEB_HOST_MODULE_SPECS),
    });
  }
}

/**
 * A namespace view that forwards to the lazily loaded module.
 *
 * Properties stay `undefined` until the module is loaded: read-only diagnostics that happen to
 * touch a vision/network constant must answer "not available" instead of throwing. Constructions
 * (`new FrameSource()`) are gated explicitly, because a silently inert page source would be worse
 * than a typed refusal.
 */

export function lazyWebNamespace(id) {
  return new Proxy({}, {
    get(_target, property) {
      if (property === 'then' || typeof property === 'symbol') return undefined;
      const namespace = webHostNamespace(id);
      return namespace ? namespace[property] : undefined;
    },
    has(_target, property) {
      const namespace = webHostNamespace(id);
      return namespace ? property in namespace : false;
    },
    ownKeys() {
      const namespace = webHostNamespace(id);
      return namespace ? Reflect.ownKeys(namespace) : [];
    },
    getOwnPropertyDescriptor(_target, property) {
      const namespace = webHostNamespace(id);
      if (!namespace) return undefined;
      const descriptor = Object.getOwnPropertyDescriptor(namespace, property);
      return descriptor ? { ...descriptor, configurable: true } : undefined;
    },
  });
}

// Web T3 static vision (docs/t3-vision.md). The Host layer never re-implements the pixel
// algorithms: it validates arguments, resolves sources, owns the product store per scope,
// delivers the single PNG and implements the act/check decision rules on top of the pure API.

// Web T3 static vision (docs/t3-vision.md). The Host layer never re-implements the pixel
// algorithms: it validates arguments, resolves sources, owns the product store per scope,
// delivers the single PNG and implements the act/check decision rules on top of the pure API.
export const vision = lazyWebNamespace('vision-t3');
// Web P0 network (docs/network-p0.md). The Host layer owns CDP collection, the single Fetch
// dispatcher and the 7 tool surfaces; every projection/aggregation/evidence rule lives in the
// pure module so it can be unit tested without a browser.

// Web P0 network (docs/network-p0.md). The Host layer owns CDP collection, the single Fetch
// dispatcher and the 7 tool surfaces; every projection/aggregation/evidence rule lives in the
// pure module so it can be unit tested without a browser.
export const network = lazyWebNamespace('network-p0');
// FR-11 Cookie Store (cookie-store.js). The Host layer owns the CDP Network.getCookies call, the
// human-issued approval file and the controlled export write; every projection/validation rule
// (origin match, metadata whitelist, approval binding, no-clobber 0600, canary scan) lives in the
// pure module so it can be unit tested without a browser.

// FR-11 Cookie Store (cookie-store.js). The Host layer owns the CDP Network.getCookies call, the
// human-issued approval file and the controlled export write; every projection/validation rule
// (origin match, metadata whitelist, approval binding, no-clobber 0600, canary scan) lives in the
// pure module so it can be unit tested without a browser.
export const cookieStore = lazyWebNamespace('cookie-store');
// FR-01 Scope & Safety Controller (security-scope.js): session authorization boundary — origin
// allowlist, path constraints, request budget, passive/active mode, stop switch, audit trail.

// FR-01 Scope & Safety Controller (security-scope.js): session authorization boundary — origin
// allowlist, path constraints, request budget, passive/active mode, stop switch, audit trail.
export const securityScope = lazyWebNamespace('security-scope');
// FR-02 Attack Surface Discovery (attack-surface.js): structured inventory from the network
// collector + DOM facts; evidence levels observed/inferred/unverified are the contract.

// FR-02 Attack Surface Discovery (attack-surface.js): structured inventory from the network
// collector + DOM facts; evidence levels observed/inferred/unverified are the contract.
export const attackSurface = lazyWebNamespace('attack-surface');
// FR-03/FR-04 JavaScript static analysis (script-analysis.js): script inventory, formatting,
// string-table recovery and source-to-sink location. Debugger.enable is opt-in per Runtime.

// FR-03/FR-04 JavaScript static analysis (script-analysis.js): script inventory, formatting,
// string-table recovery and source-to-sink location. Debugger.enable is opt-in per Runtime.
export const scriptAnalysis = lazyWebNamespace('script-analysis');
// FR-05 runtime analysis (runtime-debug.js): breakpoints, pause state machine with a hard
// timeout-resume guard, call-stack/request correlation and per-scope variable redaction.

// FR-05 runtime analysis (runtime-debug.js): breakpoints, pause state machine with a hard
// timeout-resume guard, call-stack/request correlation and per-scope variable redaction.
export const runtimeDebug = lazyWebNamespace('runtime-debug');
// FR-09/FR-10 findings + rules (finding.js / security-rules.js): the status derivation is the only
// legal path from evidence to `confirmed`, so a static pattern can never be promoted.

// FR-09/FR-10 findings + rules (finding.js / security-rules.js): the status derivation is the only
// legal path from evidence to `confirmed`, so a static pattern can never be promoted.
export const findingLib = lazyWebNamespace('finding');

export const securityRules = lazyWebNamespace('security-rules');
// FR-08 business logic (business-logic.js): invariants over SERVER state (quantity/price bounds,
// coupon reuse, client-trusted amounts, idempotency, illegal transitions, repeatability).

// FR-08 business logic (business-logic.js): invariants over SERVER state (quantity/price bounds,
// coupon reuse, client-trusted amounts, idempotency, illegal transitions, repeatability).
export const businessLogic = lazyWebNamespace('business-logic');
/**
 * A lazily forwarded *value* export (not a namespace): `CAPTURE_LIMITS.scaleMin` must read the
 * module's `CAPTURE_LIMITS` object, not the module namespace itself.
 */

export function lazyWebValue(id, exportName) {
  return new Proxy({}, {
    get(_target, property) {
      if (property === 'then' || typeof property === 'symbol') return undefined;
      const namespace = webHostNamespace(id);
      const value = namespace ? namespace[exportName] : undefined;
      return value ? value[property] : undefined;
    },
    has(_target, property) {
      const namespace = webHostNamespace(id);
      const value = namespace ? namespace[exportName] : undefined;
      return value ? property in value : false;
    },
    ownKeys() {
      const namespace = webHostNamespace(id);
      const value = namespace ? namespace[exportName] : undefined;
      return value ? Reflect.ownKeys(value) : [];
    },
    getOwnPropertyDescriptor(_target, property) {
      const namespace = webHostNamespace(id);
      const value = namespace ? namespace[exportName] : undefined;
      const descriptor = value ? Object.getOwnPropertyDescriptor(value, property) : undefined;
      return descriptor ? { ...descriptor, configurable: true } : undefined;
    },
  });
}

/** Capture-p0 constants (a value export, hence `lazyWebValue`); functions forward on call. */

/** Capture-p0 constants (a value export, hence `lazyWebValue`); functions forward on call. */
export const CAPTURE_LIMITS = lazyWebValue('capture-p0', 'CAPTURE_LIMITS');

export const checkPixelSize = (...args) => webHostNamespace('capture-p0').checkPixelSize(...args);

export const composeCanvasImage = (...args) => webHostNamespace('capture-p0').composeCanvasImage(...args);

export const createCaptureMapping = (...args) => webHostNamespace('capture-p0').createCaptureMapping(...args);

export const decodePng = (...args) => webHostNamespace('capture-p0').decodePng(...args);

export const detectImageAnomaly = (...args) => webHostNamespace('capture-p0').detectImageAnomaly(...args);

export const encodePngRgba = (...args) => webHostNamespace('capture-p0').encodePngRgba(...args);

export const expectedPixelSize = (...args) => webHostNamespace('capture-p0').expectedPixelSize(...args);

export const hasPositiveOutputSize = (...args) => webHostNamespace('capture-p0').hasPositiveOutputSize(...args);

export const inspectPng = (...args) => webHostNamespace('capture-p0').inspectPng(...args);

export const intersectRects = (...args) => webHostNamespace('capture-p0').intersectRects(...args);

export const projectCaptureMapping = (...args) => webHostNamespace('capture-p0').projectCaptureMapping(...args);

export const publishCapture = (...args) => webHostNamespace('capture-p0').publishCapture(...args);

export const resolveCapturePath = (...args) => webHostNamespace('capture-p0').resolveCapturePath(...args);

export const createBaselineStore = (...args) => webHostNamespace('vision-baseline').createBaselineStore(...args);
/** `new FrameSource()` must refuse instead of returning an inert source. */

/** Page audio tap constants (binding name, sample rate, encoding) for the injected script. */
export const audioTap = lazyWebNamespace('audio-tap');
/** `new AudioSource()` must refuse instead of returning an inert store, like FrameSource. */
export const AudioSource = new Proxy(function AudioSourceLazy() {}, {
  construct(_target, args, newTarget) {
    const namespace = webHostNamespace('audio-source');
    if (!namespace) {
      throw new BrowserError('ADAPTER_DISABLED', 'Web 音频源尚未加载：当前进程未启用 Web 环境', {
        module: 'audio-source',
      });
    }
    return Reflect.construct(namespace.AudioSource, args, newTarget === AudioSource ? namespace.AudioSource : newTarget);
  },
});

/** `new FrameSource()` must refuse instead of returning an inert source. */
export const FrameSource = new Proxy(function FrameSourceLazy() {}, {
  construct(_target, args, newTarget) {
    const namespace = webHostNamespace('frame-source');
    if (!namespace) {
      throw new BrowserError('ADAPTER_DISABLED', 'Web 帧源尚未加载：当前进程未启用 Web 环境', {
        module: 'frame-source',
      });
    }
    return Reflect.construct(namespace.FrameSource, args, newTarget === FrameSource ? namespace.FrameSource : newTarget);
  },
  get(_target, property) {
    if (property === 'prototype') return webHostNamespace('frame-source')?.FrameSource?.prototype ?? {};
    return undefined;
  },
});
// Re-exported for callers that import the platform error classes with the runtime.
export { BrowserError, Cdp } from '../../browser-safety.js';
/**
 * Load the Web-only host modules on demand (A14).
 *
 * The plugin loads them itself before the first call that needs them; this export exists for
 * tests/diagnostics that construct the Web `Runtime` directly and therefore sit outside that gate.
 */

export const CHROME_ENV = 'DSH_UI_TESTING_CHROME';
/** The existing install keeps priority; then PATH order (no cwd, no other profile search). */

/** The existing install keeps priority; then PATH order (no cwd, no other profile search). */
export const CHROME_DEFAULT_CANDIDATE = '/opt/google/chrome/chrome';
/** Per-directory PATH order is fixed: stable package first. */

/** Per-directory PATH order is fixed: stable package first. */
export const CHROME_PATH_NAMES = Object.freeze(['google-chrome-stable', 'google-chrome', 'chromium', 'chromium-browser']);
/** Windows PATH shims carry an extension, so the POSIX names above can never match there. */

/** Windows PATH shims carry an extension, so the POSIX names above can never match there. */
export const CHROME_WIN_PATH_NAMES = Object.freeze([
  'chrome.exe', 'google-chrome-stable.exe', 'google-chrome.exe', 'chromium.exe', 'chromium-browser.exe',
]);
/** Known Windows install tails, resolved under each program root (no registry probing). */

/** Known Windows install tails, resolved under each program root (no registry probing). */
export const CHROME_WIN_INSTALL_TAILS = Object.freeze([
  'Google\\Chrome\\Application\\chrome.exe',
  'Google\\Chrome Beta\\Application\\chrome.exe',
  'Google\\Chrome Dev\\Application\\chrome.exe',
  'Google\\Chrome SxS\\Application\\chrome.exe',
  'Chromium\\Application\\chrome.exe',
]);
/** Windows cannot execute these through CreateProcess; X_OK would accept any readable file. */

/** Windows cannot execute these through CreateProcess; X_OK would accept any readable file. */
export const WIN_EXECUTABLE_EXTENSIONS = Object.freeze(['.exe', '.cmd', '.bat', '.com']);
/** Platform-adaptive tail (macOS application bundles); Linux is covered by the paths above. */

/** Platform-adaptive tail (macOS application bundles); Linux is covered by the paths above. */
export const CHROME_MAC_CANDIDATES = Object.freeze([
  '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome',
  '/Applications/Google Chrome Canary.app/Contents/MacOS/Google Chrome Canary',
  '/Applications/Chromium.app/Contents/MacOS/Chromium',
]);
/** Keep a failed-discovery message bounded even with a long PATH. */

/** Keep a failed-discovery message bounded even with a long PATH. */
export const CHROME_CANDIDATE_LIMIT = 24;

export let chromeResolution;

export function isExecutableFile(candidate, platform = process.platform) {
  try {
    if (!statSync(candidate).isFile()) return false;
    // On Windows X_OK is a no-op (any readable file "passes"), so the extension decides.
    if (platform === 'win32' && !WIN_EXECUTABLE_EXTENSIONS.includes(extname(candidate).toLowerCase())) return false;
    return (accessSync(candidate, fsConstants.X_OK), true);
  } catch {
    return false;
  }
}

/** PATH directories: deduped, empty entries dropped (an empty entry must never mean cwd). */

/** PATH directories: deduped, empty entries dropped (an empty entry must never mean cwd). */
export function searchDirsFrom(pathDirs, platform = process.platform) {
  const dirs = pathDirs === undefined ? String(process.env.PATH || '').split(delimiter) : pathDirs;
  // Windows PATH entries are often quoted; a quoted root would never match a joined candidate.
  const cleaned = platform === 'win32' ? dirs.map((dir) => String(dir).replace(/^"(.*)"$/, '$1')) : dirs;
  return [...new Set(cleaned.filter(Boolean))];
}

/** Known Windows install locations for Chrome/Chromium channels (stable channel first). */

/** Known Windows install locations for Chrome/Chromium channels (stable channel first). */
export function chromeWinCandidatesFrom(env) {
  const roots = [env.PROGRAMFILES, env['PROGRAMFILES(X86)'], env.PROGRAMW6432, env.LOCALAPPDATA].filter(Boolean);
  const out = [];
  const seen = new Set();
  for (const root of roots) {
    for (const tail of CHROME_WIN_INSTALL_TAILS) {
      const candidate = join(root, tail);
      if (seen.has(candidate)) continue;
      seen.add(candidate);
      out.push(candidate);
    }
  }
  return out;
}

/**
 * A bare command name on Windows is resolved through PATHEXT by the shell, not by CreateProcess;
 * probing the literal name would miss every `chrome.exe` shim on PATH.
 */

export function commandCandidates(command, platform = process.platform) {
  if (platform !== 'win32') return [command];
  if (extname(command) !== '') return [command];
  const extensions = String(process.env.PATHEXT || '.COM;.EXE;.BAT;.CMD').split(';').filter(Boolean);
  return [command, ...extensions.map((extension) => command + extension.toLowerCase())];
}

export function chromeCandidates(defaultCandidate, dirs, macCandidates, winCandidates = [], platform = process.platform) {
  const names = platform === 'win32' ? CHROME_WIN_PATH_NAMES : CHROME_PATH_NAMES;
  return [...new Set([
    ...(defaultCandidate ? [defaultCandidate] : []),
    ...dirs.flatMap((dir) => names.map((name) => join(dir, name))),
    ...macCandidates,
    ...(platform === 'win32' ? winCandidates : []),
  ])];
}

/**
 * Pure discovery order — the candidate list from docs/getting-started.md, without touching the
 * filesystem. Separated from {@link resolveChromeExecutable} so the composition (which roots, which
 * PATH names, never the other platform's shapes) is assertable on any host; whether a candidate
 * actually exists stays a host question.
 */

export function chromeCandidatePaths({
  platform = process.platform, env = process.env, pathDirs,
  defaultCandidate = CHROME_DEFAULT_CANDIDATE, macCandidates = CHROME_MAC_CANDIDATES, winCandidates,
} = {}) {
  return chromeCandidates(
    // A POSIX default path can never exist on Windows and only pads the error message there.
    platform === 'win32' ? undefined : defaultCandidate,
    searchDirsFrom(pathDirs, platform),
    macCandidates,
    winCandidates === undefined ? (platform === 'win32' ? chromeWinCandidatesFrom(env) : []) : winCandidates,
    platform,
  );
}

/** UNSUPPORTED/capability/false: no usable browser. The message lists candidates, never secrets. */

/** UNSUPPORTED/capability/false: no usable browser. The message lists candidates, never secrets. */
export function chromeUnsupported(reason, candidates) {
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
 * callers pass nothing and get the cached answer. The candidate composition itself is
 * {@link chromeCandidatePaths}.
 */

export function resolveChromeExecutable({
  override, pathDirs, defaultCandidate = CHROME_DEFAULT_CANDIDATE, macCandidates = CHROME_MAC_CANDIDATES,
  winCandidates, platform = process.platform, env = process.env,
} = {}) {
  const explicit = override !== undefined
    ? override
    : { present: CHROME_ENV in env, value: env[CHROME_ENV] };
  const cacheable = override === undefined && pathDirs === undefined && winCandidates === undefined
    && defaultCandidate === CHROME_DEFAULT_CANDIDATE && macCandidates === CHROME_MAC_CANDIDATES
    && platform === process.platform && env === process.env;
  const cacheKey = `${platform}|${explicit.present ? `${CHROME_ENV}=${explicit.value}` : '(default)'}`;
  if (cacheable && chromeResolution && chromeResolution.key === cacheKey) return chromeResolution.path;
  const dirs = searchDirsFrom(pathDirs, platform);

  if (explicit.present) {
    const raw = explicit.value === undefined || explicit.value === null ? '' : String(explicit.value);
    // An explicit override is authoritative: an unusable value is an operator error, not a
    // reason to silently run a different browser.
    if (raw === '') throw new BrowserError('INVALID_ARGUMENT', `${CHROME_ENV} 不能是空字符串；请删除该变量或给出绝对路径/命令名`);
    if (raw.includes('\0')) throw new BrowserError('INVALID_ARGUMENT', `${CHROME_ENV} 不能包含 NUL 字符`);
    if (!isAbsolute(raw)) {
      if (/[\\/]/.test(raw)) throw new BrowserError('INVALID_ARGUMENT', `${CHROME_ENV} 只接受绝对路径或 PATH 中的单个命令名：${raw}`);
      const tried = dirs.flatMap((dir) => commandCandidates(raw, platform).map((name) => join(dir, name)));
      const hit = tried.find((candidate) => isExecutableFile(candidate, platform));
      if (!hit) throw chromeUnsupported(`${CHROME_ENV} 指定的命令在 PATH 中不可执行：${raw}`, tried);
      if (cacheable) chromeResolution = { key: cacheKey, path: hit };
      return hit;
    }
    if (!isExecutableFile(raw, platform)) {
      throw chromeUnsupported(`${CHROME_ENV} 指向的 Chrome 不可用（不存在或不可执行）：${raw}`, [raw]);
    }
    if (cacheable) chromeResolution = { key: cacheKey, path: raw };
    return raw;
  }

  const candidates = chromeCandidatePaths({ platform, env, pathDirs, defaultCandidate, macCandidates, winCandidates });
  const found = candidates.find((candidate) => isExecutableFile(candidate, platform));
  if (!found) throw chromeUnsupported('找不到可用的 Chrome/Chromium 可执行文件', candidates);
  if (cacheable) chromeResolution = { key: cacheKey, path: found };
  return found;
}

/**
 * Terminate a spawned browser and every process it created.
 *
 * On Windows there is no signal delivery for console children: child.kill() is a TerminateProcess
 * on that one PID, so Chrome's own children survive and keep the temporary profile locked.
 * taskkill /T kills the tree the browser was spawned into; POSIX keeps the SIGTERM-first path.
 */

export function terminateProcessTree(proc, { force = false } = {}) {
  const pid = proc && proc.pid;
  if (!pid) return;
  if (process.platform === 'win32') {
    try {
      execFileSync('taskkill', ['/PID', String(pid), '/T', ...(force ? ['/F'] : [])], {
        stdio: 'ignore', timeout: 5000, windowsHide: true,
      });
      return;
    } catch { /* taskkill unavailable or process already gone: fall through */ }
  }
  try { proc.kill(force ? 'SIGKILL' : 'SIGTERM'); } catch { /* ignore */ }
}

/**
 * Windows: drop the headed browser window out of the taskbar and Alt-Tab.
 *
 * `--window-position=-10000,-10000` parks the window offscreen but the shell still shows a taskbar
 * button and an Alt-Tab entry for a visible, unowned top-level window. Marking it
 * WS_EX_TOOLWINDOW (and clearing WS_EX_APPWINDOW, then HIDE + SHOW_NOACTIVATE so the shell
 * re-evaluates) removes both.
 *
 * SW_HIDE alone is not an option: a genuinely hidden window makes the page `hidden`, which stops
 * rAF and screencast frames — exactly the feed the debug panel renders. There is no CLI for window
 * styles, so this is a bounded best-effort PowerShell call; every failure is non-fatal and only
 * means the window keeps its taskbar button.
 *
 * @returns {boolean} true when at least one window was restyled
 */

export function hideHeadedWindowWin32(pid) {
  const systemRoot = process.env.SystemRoot || process.env.windir || 'C:\\Windows';
  const powershell = join(systemRoot, 'System32', 'WindowsPowerShell', 'v1.0', 'powershell.exe');
  const script = `
$ErrorActionPreference = 'Stop'
Add-Type -TypeDefinition @'
using System;
using System.Runtime.InteropServices;
public class DshUiTestingWin {
  public delegate bool EnumProc(IntPtr hWnd, IntPtr lParam);
  [DllImport("user32.dll")] public static extern bool EnumWindows(EnumProc cb, IntPtr lParam);
  [DllImport("user32.dll")] public static extern uint GetWindowThreadProcessId(IntPtr hWnd, out uint pid);
  [DllImport("user32.dll")] public static extern bool IsWindowVisible(IntPtr hWnd);
  [DllImport("user32.dll")] public static extern IntPtr GetWindow(IntPtr hWnd, uint cmd);
  [DllImport("user32.dll", EntryPoint = "GetWindowLongPtrW")] public static extern IntPtr GetWindowLongPtr(IntPtr hWnd, int index);
  [DllImport("user32.dll", EntryPoint = "SetWindowLongPtrW")] public static extern IntPtr SetWindowLongPtr(IntPtr hWnd, int index, IntPtr value);
  [DllImport("user32.dll")] public static extern bool ShowWindow(IntPtr hWnd, int cmd);
}
'@
$target = [uint32]${pid}
$script:hits = 0
$cb = [DshUiTestingWin+EnumProc]{
  param($hWnd, $lParam)
  [uint32]$owner = 0
  [void][DshUiTestingWin]::GetWindowThreadProcessId($hWnd, [ref]$owner)
  if ($owner -eq $target -and [DshUiTestingWin]::IsWindowVisible($hWnd) -and [DshUiTestingWin]::GetWindow($hWnd, 4) -eq [IntPtr]::Zero) {
    $ex = [int64][DshUiTestingWin]::GetWindowLongPtr($hWnd, -20)
    $new = ($ex -bor 0x80) -band (-bnot 0x40000)
    [void][DshUiTestingWin]::SetWindowLongPtr($hWnd, -20, [IntPtr]$new)
    [void][DshUiTestingWin]::ShowWindow($hWnd, 0)
    [void][DshUiTestingWin]::ShowWindow($hWnd, 4)
    $script:hits++
  }
  return $true
}
[void][DshUiTestingWin]::EnumWindows($cb, [IntPtr]::Zero)
if ($script:hits -gt 0) { '1' } else { '0' }
`;
  try {
    const output = execFileSync(powershell, [
      '-NoProfile', '-NonInteractive', '-ExecutionPolicy', 'Bypass',
      '-EncodedCommand', Buffer.from(script, 'utf16le').toString('base64'),
    ], { encoding: 'utf8', timeout: 4000, windowsHide: true, stdio: ['ignore', 'pipe', 'ignore'] });
    return String(output).trim() === '1';
  } catch {
    return false;
  }
}

export const ROUTE_PREFIX = '/plugins/ui-testing';

export const NETWORK_LIMIT = 300;

export const AGENT_HOLD_MS = 15000;
/** Bounded retry for the exact mkdtemp profile cleanup (transient ENOTEMPTY/EBUSY/EPERM). */
/* Windows holds handles on a just-killed profile longer (AV, crashpad), so retry harder there. */

/** Bounded retry for the exact mkdtemp profile cleanup (transient ENOTEMPTY/EBUSY/EPERM). */
/* Windows holds handles on a just-killed profile longer (AV, crashpad), so retry harder there. */
export const PROFILE_RM_RETRIES = process.platform === 'win32' ? 20 : 5;

export const PROFILE_RM_RETRY_DELAY_MS = process.platform === 'win32' ? 150 : 50;
/** How long a reload / history command may take to commit its main-frame navigation. */

/** How long a reload / history command may take to commit its main-frame navigation. */
export const COMMIT_TIMEOUT_MS = 10000;
/** Upper bound of one `browser_input` batch (schema maxItems mirrors this number). */

/** Upper bound of one `browser_input` batch (schema maxItems mirrors this number). */
export const INPUT_EVENT_LIMIT = 200;
/**
 * Upper bound of the inline base64 fallback returned by `browser_screenshot`. The attachment is
 * still delivered when the host provides one; above this many base64 characters the inline text is
 * omitted and `capture.warnings` carries `image_base64_omitted` (24 MiB).
 */

export const IMAGE_INLINE_BASE64_LIMIT = 24 * 1024 * 1024;
/** Throttle for the merged background title/url/history read (UI polls at 500ms / 80ms). */

/** Throttle for the merged background title/url/history read (UI polls at 500ms / 80ms). */
export const METADATA_THROTTLE_MS = 250;

export const SKILL_NAME = 'ui-testing-web';

export const SKILL_DIR = fileURLToPath(new URL('../../skills/ui-testing-web/', import.meta.url));

export const SKILL_FALLBACK_DESCRIPTION =
  'Web/Chromium UI testing through 36 bundled browser_* tools: T1 programmatic (navigation, eval, input, ' +
  'network, computed style, screenshots, independent HTTP, viewport, state, capabilities), T2 structured GUI, ' +
  'T3 static vision, T4 dynamic behavior, network P0 capture/control/evidence, and the P0-E page group ' +
  '(browser_tabs). Use for authorized web UI inspection, interaction, API requests and verification.';

/**
 * CDP Input modifier bitmask: Alt=1, Ctrl=2, Meta=4, Shift=8 (see Input.dispatchKeyEvent).
 * `browser_input` accepts either the string form ['alt','ctrl','meta','shift'] or the raw mask.
 */

export const MODIFIER_BITS = Object.freeze({ alt: 1, ctrl: 2, meta: 4, shift: 8 });

export const MODIFIER_MASK = Object.values(MODIFIER_BITS).reduce((mask, bit) => mask | bit, 0);
/** Key event types the CDP Input domain actually accepts. */

/** Key event types the CDP Input domain actually accepts. */
export const KEY_EVENT_TYPES = Object.freeze(['keyDown', 'keyUp', 'rawKeyDown', 'char']);
/** CDP pointer types (Input.dispatchMouseEvent.pointerType). */

/** The UI history projection when no CDP navigation history is available (or not running). */

/** The UI history projection when no CDP navigation history is available (or not running). */
export function emptyHistory() {
  return { available: false, index: -1, length: 0, canGoBack: false, canGoForward: false };
}

export function normalizeModifiers(value) {
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

export function normalizePointerType(value) {
  if (value === undefined || value === null) return undefined;
  if (typeof value === 'string') {
    const name = value.trim().toLowerCase();
    if (name === 'mouse' || name === 'pen') return name;
  }
  if (value === 1) return 'mouse';
  if (value === 2) return 'pen';
  throw new BrowserError('INVALID_ARGUMENT', 'pointerType 只支持 mouse/pen（兼容 CDP 的 1/2）');
}

export function normalizeKeyEventType(value) {
  if (!KEY_EVENT_TYPES.includes(value)) {
    throw new BrowserError('INVALID_ARGUMENT', `key 事件 type 无效：${JSON.stringify(value)}（可用 ${KEY_EVENT_TYPES.join('/')}）`);
  }
  return value;
}

/**
 * Held-key identity for the input state machine (`browser_input`).
 *
 * Keyed by physical `code` when present (so `ShiftLeft`/`ShiftRight` stay distinct until the
 * modifier bit is derived) and falling back to `key` for callers that only pass a character.
 */

export function inputKeyIdentity(event) {
  const code = typeof event.code === 'string' ? event.code.trim() : '';
  const key = typeof event.key === 'string' ? event.key.trim() : '';
  return (code || key).toLowerCase();
}

/** Which modifier bit a key stands for, if any (CDP: Alt=1, Ctrl=2, Meta=4, Shift=8). */

/** Which modifier bit a key stands for, if any (CDP: Alt=1, Ctrl=2, Meta=4, Shift=8). */
export function inputKeyModifier(event) {
  const code = typeof event.code === 'string' ? event.code.toLowerCase() : '';
  const key = typeof event.key === 'string' ? event.key.toLowerCase() : '';
  if (code.startsWith('shift') || key === 'shift') return 8;
  if (code.startsWith('control') || key === 'control') return 2;
  if (code.startsWith('alt') || key === 'alt') return 1;
  if (code.startsWith('meta') || key === 'meta' || key === 'os') return 4;
  return 0;
}

/** True for the event types that *press* a key (everything except keyUp). */

/** True for the event types that *press* a key (everything except keyUp). */
export function inputPressesKey(type) {
  const normalized = String(type || '').toLowerCase();
  return normalized === 'keydown' || normalized === 'rawkeydown' || normalized === 'char';
}

/**
 * Turn one caller-supplied input event into CDP parameters.
 * Validation happens here, before the browser is started, so bad arguments never launch Chromium.
 */

export function prepareInputEvent(event) {
  const modifiers = normalizeModifiers(event.modifiers);
  // Relative motion (`kind:'mouse'` + deltaX/deltaY) and the modifier-synthesis escape hatch are
  // Host-side fields, not CDP parameters: validate them here so a bad value never starts Chromium.
  for (const field of ['deltaX', 'deltaY']) {
    if (event[field] === undefined) continue;
    if (typeof event[field] !== 'number' || !Number.isFinite(event[field])) {
      throw new BrowserError('INVALID_ARGUMENT', `输入事件 ${field} 必须是有限数`, {
        field, valueType: typeof event[field],
      });
    }
  }
  if (event.synthesizeModifiers !== undefined && typeof event.synthesizeModifiers !== 'boolean') {
    throw new BrowserError('INVALID_ARGUMENT', '输入事件 synthesizeModifiers 必须是布尔值', {
      field: 'synthesizeModifiers', valueType: typeof event.synthesizeModifiers,
    });
  }
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

export function losslessJson(value, path = 'value', notes = []) {
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

export function projectAttachment(attachment) {
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

/** Closed warning vocabulary: deduplicated, order preserving, never silently dropped. */
export const CAPTURE_WARNING_VOCABULARY = Object.freeze([
  'content_uniform', 'content_transparent', 'model_image_downscaled', 'attachment_reencoded',
  'blank_check_skipped', 'capture_file_unavailable', 'attachment_unavailable', 'capture_beyond_viewport',
  // A 16M-pixel PNG can encode to tens of MiB of base64; above the inline cap only the attachment
  // (when one exists) is delivered and the fallback text is omitted.
  'image_base64_omitted',
]);

export function addCaptureWarning(warnings, code) {
  if (!CAPTURE_WARNING_VOCABULARY.includes(code)) {
    throw new BrowserError('INTERNAL', '未登记的截图警告码：' + code);
  }
  if (!warnings.includes(code)) warnings.push(code);
  return warnings;
}

/* ---------------------------------------------------------------------------------------------
 * Shared viewport (docs/viewport-control.md, Lead freeze 2026-11-01)
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

/** The four GUI presets (docs/viewport-control.md); 1280×800 derives `custom`. */

/** The four GUI presets (docs/viewport-control.md); 1280×800 derives `custom`. */
export const VIEW_PRESETS = Object.freeze({
  wide: Object.freeze({ width: 1920, height: 1080 }),
  landscape: Object.freeze({ width: 1024, height: 768 }),
  tablet: Object.freeze({ width: 768, height: 1024 }),
  phone: Object.freeze({ width: 393, height: 852 }),
});

export const VIEW_LIMITS = Object.freeze({
  width: Object.freeze([200, 4096]),
  height: Object.freeze([200, 4096]),
  scroll: Object.freeze([0, 10000000]),
  /** Canvas coordinates may be negative and may leave the content box (docs/viewport-control.md). */
  canvas: Object.freeze([-10000000, 10000000]),
  scale: Object.freeze([0.1, 2]),
  /** ui.canvas / capture provenance advertise the composited blank colour (docs/viewport-control.md). */
  canvasBlankColor: '#ffffff',
  default: Object.freeze({ width: 1280, height: 800, x: 0, y: 0, scale: 1 }),
  /** Contract §3.2: at most one metrics read every 200ms while a viewer is attached. */
  scrollPollMinMs: 200,
  /** Cached observation older than this is reported stale (never silently "fresh"). */
  staleAfterMs: 1000,
  /** set() waits two frames and at most this long for a stable readback. */
  settleMaxMs: 1000,
});

/** Fields a `view` patch may carry; `mode` expands to width/height and is never stored. */

/** Fields a `view` patch may carry; `mode` expands to width/height and is never stored. */
export const VIEW_FIELDS = Object.freeze(['mode', 'x', 'y', 'canvasX', 'canvasY', 'width', 'height', 'scale']);

/** Derived mode name for a final width/height pair. */

/** Derived mode name for a final width/height pair. */
export function viewModeFor(width, height) {
  for (const [mode, size] of Object.entries(VIEW_PRESETS)) {
    if (width === size.width && height === size.height) return mode;
  }
  return 'custom';
}

/**
 * Pure pre-flight for `browser_viewport` (docs/viewport-control.md): no browser, no CDP, no file.
 *
 * Rejects unknown fields, an illegal action, `get` with any other field, an empty patch, a
 * `mode`+width/height conflict, non-finite/non-integer/out-of-range numbers. A rejected call must
 * cost neither a browser start nor a page change (contract §7.1 INVALID_ARGUMENT).
 */

export function normalizeViewportRequest(args) {
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
  // Canvas coordinates (docs/viewport-control.md): C = viewport origin on the canvas, can be
  // negative or outside the content box. They are a different coordinate space from x/y (document
  // scroll), so one patch must never carry both — the caller has to choose which one it means.
  for (const key of ['canvasX', 'canvasY']) {
    if (input[key] === undefined) continue;
    const value = input[key];
    if (typeof value !== 'number' || !Number.isFinite(value)) {
      throw new BrowserError('INVALID_ARGUMENT', `${key} 必须是有限数字（画布 CSS 像素，可为负）`, {
        field: key, valueType: Array.isArray(value) ? 'array' : typeof value,
      });
    }
    if (value < VIEW_LIMITS.canvas[0] || value > VIEW_LIMITS.canvas[1]) {
      throw new BrowserError('INVALID_ARGUMENT', `${key} 超出允许范围`, {
        field: key, min: VIEW_LIMITS.canvas[0], max: VIEW_LIMITS.canvas[1], value,
      });
    }
    patch[key] = value;
  }
  if ((patch.canvasX !== undefined || patch.canvasY !== undefined) && (patch.x !== undefined || patch.y !== undefined)) {
    throw new BrowserError('INVALID_ARGUMENT', 'canvasX/canvasY 不能与 x/y 同时给出（画布坐标与文档滚动是两种坐标空间）', {
      fields: ['canvasX', 'canvasY', 'x', 'y'],
    });
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
    throw new BrowserError('INVALID_ARGUMENT', 'action=set 至少需要一个 view 字段（mode/x/y/canvasX/canvasY/width/height/scale）', {
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

export function expandViewPatch(patch) {
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
 * §6.1). `region` is a canvas-CSS rectangle with four finite numbers and width/height >= 1
 * (identical to document CSS when the canvas offset O=0);
 * `out` is an optional relative .png path.
 */

export function normalizeCaptureRequest(args) {
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
      throw new BrowserError('INVALID_ARGUMENT', 'region 必须是 {x,y,width,height} 对象（canvas CSS 像素；O=0 时与文档相同）', { field: 'region' });
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
  const includeAnnotations = input.includeAnnotations === undefined ? false : input.includeAnnotations;
  if (typeof includeAnnotations !== 'boolean') {
    throw new BrowserError('INVALID_ARGUMENT', 'includeAnnotations 必须是布尔值（true = 叠加面板标注）', {
      field: 'includeAnnotations', valueType: typeof includeAnnotations,
    });
  }
  return { scale, region, out, persist, includeAnnotations };
}

/** Pixel budget, judged before any CDP screenshot: Chrome must never be asked for more. */

/** Pixel budget, judged before any CDP screenshot: Chrome must never be asked for more. */
export function assertCaptureBudget(rect, scale) {
  const expected = expectedPixelSize({ width: rect.width, height: rect.height, scale, deviceScaleFactor: 1 });
  // A small region at a low scale can round to 0 px on an axis (docs/viewport-control.md):
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
/** Reject unknown tool fields (docs/network-p0.md: `additionalProperties:false`). */

/** Reject unknown tool fields (docs/network-p0.md: `additionalProperties:false`). */
export function assertKnownKeys(value, allowed, label) {
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

/** The configured persistent capture root (env override), or null when unset/blank. */
export function captureEnvRoot() {
  const override = process.env.DSH_UI_TESTING_CAPTURE_DIR;
  return typeof override === 'string' && override.trim() !== '' ? override.trim() : null;
}

/**
 * FR-11 authorization directory (GATE-03): the same directory the plugin config lives in
 * (integration/cross-environment.js configDirectory). The human edits security-approvals.json
 * there; the Agent has no write channel to it (ConfigStore patch keys do not include it and no
 * tool writes it), so an approval in that file is a *human* statement, never an Agent echo.
 */

export function cookieApprovalsDir() {
  const explicit = process.env.DSH_UI_TESTING_CONFIG_DIR;
  if (typeof explicit === 'string' && explicit.trim() !== '') return explicit.trim();
  const home = process.env.DSH_HOME && String(process.env.DSH_HOME).trim() !== ''
    ? String(process.env.DSH_HOME).trim()
    : join(homedir(), '.dsh');
  return join(home, 'ui-testing');
}

/** Persistent root: env wins, otherwise the calling session's own workspace directory. */

/** Persistent root: env wins, otherwise the calling session's own workspace directory. */
export function captureRootFor(exec) {
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

export const NETWORK_SUBTARGETS = Object.freeze({
  workers: 'page-attached',
  shared_worker: 'not-collected',
  service_worker: 'not-collected',
  oopif: 'partial',
  partial: true,
  reason: 'attaching a service_worker target pauses it at start (waitForDebuggerOnStart) and breaks serviceWorker.register()/controller, so it is refused; shared_worker is not attached by a page-level auto-attach in this build; popup targets stay blocked; cross-site OOPIF not separately verified',
});

export const CAPTURE_PERSIST_RULES = Object.freeze(['out', 'persist:true', 'DSH_UI_TESTING_CAPTURE_DIR']);

/**
 * Read the bundled ui-testing SKILL.md and turn it into a runtime skill registration.
 * The body is the single source of truth; the description comes from frontmatter when it is a
 * single-line scalar, otherwise a reviewed constant is used. Returns undefined only when the
 * skill file is absent (a tools-only deployment stays usable).
 */

export function readBundledSkill() {
  const file = join(SKILL_DIR, 'SKILL.md');
  let raw;
  try {
    raw = readFileSync(file, 'utf8');
  } catch {
    return undefined;
  }
  const frontmatter = /^---\r?\n([\s\S]*?)\r?\n---(?:\r?\n|$)/u.exec(raw);
  if (!frontmatter) throw new Error('skills/ui-testing-web/SKILL.md 缺少 YAML frontmatter');
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

export const MAX_PAGES_DEFAULT = 8;

/**
 * Runtime provider (browser) this host container is keyed by (contract §6). Mirrors core's
 * `DEFAULT_WEB_PROVIDER`; the *support* truth (which providers may execute at all) lives only in
 * core's `WEB_PROVIDER_SUPPORT`, never here.
 */

export const DEFAULT_RUNTIME_PROVIDER = 'chrome';

/**
 * Every page group in this module belongs to the Web environment (index.js *is* the Web
 * implementation); the neutral model still validates it like any other dimension.
 */

export const PAGE_GROUP_ENVIRONMENT = 'web';

/**
 * Root dimension for callers that cannot carry a Principal at all: the legacy panel protocol
 * (no scope headers) and any old client. It is a *separate* domain, never a wildcard — an unscoped
 * caller must not inherit an Agent's page just because it named the same workspace.
 */

export const UNSCOPED_ROOT = 'root:unscoped';

/**
 * The one function that composes a page-group key (M2a, ruling §7.4).
 *
 * It used to be `<provider>\u0000<baseKey>`, which made the workspace — not the Session — the unit
 * of page ownership: two independent sessions in one workspace resolved to the *same* entry and
 * therefore fought over one page. The root dimension is now part of the key, so "A's primary" and
 * "B's primary" are simply different keys and can never alias, be evicted for each other, or be
 * addressed across roots. No caller may hand-compose this string: everything goes through M1's
 * factory, which rejects empty/composed dimensions instead of silently building a wrong root.
 */

export function pageGroupKeyFor(provider, baseKey, rootSessionId) {
  return makePageGroupKey({
    environment: PAGE_GROUP_ENVIRONMENT,
    workspaceKey: String(baseKey),
    provider: String(provider ?? DEFAULT_RUNTIME_PROVIDER),
    rootSessionId: String(rootSessionId || UNSCOPED_ROOT),
  });
}

/** Canonical identity of one physical target inside a page group (primary stays a group alias). */

/** Canonical identity of one physical target inside a page group (primary stays a group alias). */
export function pageTargetKeyFor(groupKey, tabId) {
  return makePageTargetKey({ groupKey: String(groupKey), tabId: String(tabId) });
}

/** True when the value is already a composed page-group key (binding/recent addressing). */

/** True when the value is already a composed page-group key (binding/recent addressing). */
export function isPageGroupKey(value) {
  return typeof value === 'string' && value.startsWith(PAGE_GROUP_KEY_PREFIX);
}

/** Root recorded in a group key; a malformed key degrades to the unscoped domain, never to "any". */

/** Root recorded in a group key; a malformed key degrades to the unscoped domain, never to "any". */
export function rootOfPageGroupKey(key) {
  try { return parsePageGroupKey(key).rootSessionId; } catch { return UNSCOPED_ROOT; }
}

/**
 * Provider index key: the provider fallback must also be per root, otherwise one root's last-used
 * browser could silently become another root's routing decision for the same workspace.
 */

export function providerIndexKey(baseKey, rootSessionId) {
  return String(baseKey) + '\u0000' + String(rootSessionId || UNSCOPED_ROOT);
}

export const IDLE_MS_DEFAULT = 600000;
/** A viewer is only "visible" while the panel keeps posting metrics (WS liveness alone can leak). */

/** A viewer is only "visible" while the panel keeps posting metrics (WS liveness alone can leak). */
export const VIEWER_TTL_MS = 15000;
/** Bounded cold-entry cache: at most maxPages page entries + this many idle scope entries. */

/** Bounded cold-entry cache: at most maxPages page entries + this many idle scope entries. */
export const MAX_ENTRIES_DEFAULT = 32;
/** Per-workspace popup child cap (primary is separate; global maxPages still applies). */

/** Per-workspace popup child cap (primary is separate; global maxPages still applies). */
export const MAX_POPUP_CHILDREN_DEFAULT = 3;
/**
 * P0-E browser_tabs.wait (TOOL-P0-01): a pure Host-memory poll. The bounds are the same as the
 * tool schema so a rejected argument never reaches the browser.
 */

export const TAB_WAIT_TIMEOUT_DEFAULT_MS = 5000;

export const TAB_WAIT_TIMEOUT_MAX_MS = 30000;

export const TAB_WAIT_POLL_DEFAULT_MS = 100;

export const TAB_WAIT_POLL_MIN_MS = 50;

export const TAB_WAIT_POLL_MAX_MS = 1000;
/**
 * Bounded drain budget for a Lead takeover (ruling §5.1: default 5000ms, 0–30000).
 *
 * The budget covers *waiting for the current operation to reach a safe boundary*, never interrupting
 * it: `Runtime.run` closes the page on ABORTED/CDP_TIMEOUT, so a forced takeover would destroy a
 * member's logged-in page. Exceeding the budget is BUSY and leaves the record untouched.
 */

export const TAB_ACQUIRE_TIMEOUT_DEFAULT_MS = 5000;

export const TAB_ACQUIRE_TIMEOUT_MAX_MS = 30000;
/** How often the drain loop re-samples `active`/`inflight` (host memory only, no CDP). */

/** How often the drain loop re-samples `active`/`inflight` (host memory only, no CDP). */
export const TAB_DRAIN_POLL_MS = 25;
/** Per-workspace bounded lifecycle projections: blocked popup notices + close audit. */

/** Per-workspace bounded lifecycle projections: blocked popup notices + close audit. */
export const POPUP_NOTICES_LIMIT = 8;

export const CLOSED_HISTORY_LIMIT = 8;
/** Contract defaults, exported so acceptance tests can assert them even when env overrides. */

/** Contract defaults, exported so acceptance tests can assert them even when env overrides. */
export const WORKSPACE_ISOLATION_DEFAULTS = Object.freeze({ maxPages: MAX_PAGES_DEFAULT, idleMs: IDLE_MS_DEFAULT, viewerTtlMs: VIEWER_TTL_MS });
/** Bounded wait for a freshly created target to show up in /json/list with its debugger URL. */

/** Bounded wait for a freshly created target to show up in /json/list with its debugger URL. */
export const TARGET_WS_TIMEOUT_MS = 10000;
/** Host-owned createTarget lifetime: the response must still be adopted if the caller aborts. */

/** Host-owned createTarget lifetime: the response must still be adopted if the caller aborts. */
export const PAGE_CREATE_TIMEOUT_MS = 30000;

/**
 * DevTools popup startup contract (docs/internal/devtools-popup.md §2).
 *
 * The debugger port is chosen *before* spawn so the exact browser Origin can be allowed at launch
 * (`--remote-allow-origins`): Chrome 111+ rejects a CDP WebSocket whose Origin is not allow-listed,
 * and the wildcard `*` is forbidden by the contract. Chrome 152 does not write DevToolsActivePort
 * for an explicit port, so readiness is the `/json/version` endpoint plus the identity line the
 * child itself printed on stderr. Every failed round owns a fresh process + profile and is cleaned
 * up before the next candidate; the whole start is bounded (3 attempts / 30s).
 */

export const DEVTOOLS_STARTUP = Object.freeze({
  maxAttempts: 3,
  attemptTimeoutMs: 10000,
  totalBudgetMs: 30000,
  pollIntervalMs: 100,
  fetchTimeoutMs: 500,
  portCandidates: 5,
  stderrBufferBytes: 8192,
  killGraceMs: 1200,
  killFinalMs: 500,
});
/** Reasons that justify another bounded attempt with a fresh port/process/profile. */

/** Reasons that justify another bounded attempt with a fresh port/process/profile. */
export const DEVTOOLS_RETRYABLE = new Set(['port-unavailable', 'endpoint-mismatch', 'debugger-not-ready']);

export const delay = (ms) => new Promise((resolve) => { setTimeout(resolve, ms); });

export function envPositiveInt(name, fallback) {
  const raw = process.env[name];
  if (raw === undefined || raw === '') return fallback;
  const value = Number(raw);
  return Number.isFinite(value) && value > 0 ? Math.floor(value) : fallback;
}

export function sha256Short(value, length = 16) {
  return createHash('sha256').update(String(value)).digest('hex').slice(0, length);
}

/* ---------------------------------------------------------------------------------------------
 * P0-D annotations — the human panel's annotation document as the Agent sees it
 * (docs/viewport-control.md).
 *
 * The Host stores exactly one "last accepted" document per Runtime and exposes it through
 * `Runtime.state()` (→ `browser_state.annotations`) and the authenticated `ui.annotations`. Two
 * writers share that one document: the human panel over its scoped route
 * `POST /plugins/ui-testing/annotations`, and the Agent over the 37th tool `browser_annotation`
 * (read/draw/erase/clear). It stays ONE document on purpose: the panel already hydrates a newer
 * Host revision, so an Agent note is visible to the human with no second store and no second
 * conflict model. Agent writes additionally require a *fresh human-foreground claim* for the
 * target tab (the panel reports "I am displaying my selected tab and I am visible"), otherwise a
 * drawn note could be invisible to the person it is meant for.
 *
 * The document store below is pure data handling: it never touches page DOM/CSS, starts Chromium,
 * takes the page lease or writes page lastError. browser_screenshot may explicitly rasterize a
 * frozen document with includeAnnotations:true; raw captures and T3/T4 sources remain unannotated.
 * Human notes are untrusted hints (`source.trusted:false`).
 *
 * The limits are soft and deterministic (§11.2), and the client applies the same rule so both
 * sides converge on one normalized set: keep the newest 128 shapes, downsample every brush to
 * ≤512 points (first and last point preserved, uniform index mapping), then drop the oldest *whole*
 * shapes until both the 8192-point and the 65536-byte document budgets hold. A shape dropped as a
 * whole is counted once in `droppedShapes` — its points are NOT double counted in `droppedPoints`,
 * which only counts brush points removed by the per-shape downsampling.
 * ------------------------------------------------------------------------------------------- */

export const ANNOTATION_VERSION = 1;

export const ANNOTATION_SPACE = 'canvas-css-px';

export const ANNOTATION_LIMITS = Object.freeze({
  maxShapes: 128,
  maxPointsPerShape: 512,
  maxPointsPerDocument: 8192,
  maxTextCodeUnits: 200,
  maxDocumentBytes: 65536,
  maxBodyBytes: 262144,
  maxPanels: 16,
  staleAfterMs: 30000,
  strokeWidth: Object.freeze([1, 20]),
  textFontSize: 20,
});
/**
 * Agent write surface (`browser_annotation`, docs/viewport-control.md).
 *
 * `foregroundTtlMs` is the freshness window of the panel's "this tab is my selected tab and I am
 * visible" claim. The panel polls `/state` every 500ms for its selected tab, so a 1.5s window means
 * "the human is looking at this tab right now" while a tab switch, a closed panel or a backgrounded
 * DSH tab expires the claim within one or two polls instead of relying on the 15s viewer TTL.
 */

export const ANNOTATION_FOREGROUND_TTL_MS = 1500;

export const ANNOTATION_AGENT_ACTIONS = Object.freeze(['read', 'draw', 'erase', 'clear']);
/** One call may add at most this many shapes; the document budget is still 128. */

/** One call may add at most this many shapes; the document budget is still 128. */
export const ANNOTATION_AGENT_MAX_SHAPES_PER_CALL = 64;

export const ANNOTATION_AGENT_DEFAULT_COLOR = '#ff3b30';

export const ANNOTATION_AGENT_DEFAULT_STROKE = 3;
/** Panel eraser: r = max(strokeWidth / 2, 6) canvas CSS px (docs/viewport-control.md §11.4). */

/** Panel eraser: r = max(strokeWidth / 2, 6) canvas CSS px (docs/viewport-control.md §11.4). */
export const ANNOTATION_ERASE_MIN_RADIUS = 6;

export const ANNOTATION_ERASE_DEFAULT_RADIUS = 8;
/** Text has no measured box on the Host side: hit-test uses an estimate, never a DOM read. */

/** Text has no measured box on the Host side: hit-test uses an estimate, never a DOM read. */
export const ANNOTATION_TEXT_BOX_CHAR_RATIO = 0.6;
/** Shape geometry may sit anywhere on the canvas: C's lower bound plus the largest viewport. */

/** Shape geometry may sit anywhere on the canvas: C's lower bound plus the largest viewport. */
export const ANNOTATION_COORD_MIN = -10000000;

export const ANNOTATION_COORD_MAX = 10004096;

export const ANNOTATION_RECT_SIZE_MAX = 4096;

export const ANNOTATION_ELLIPSE_RADIUS_MAX = 2048;

export const ANNOTATION_TYPES = Object.freeze(['circle', 'rect', 'line', 'arrow', 'brush', 'text']);

export const ANNOTATION_SURFACES = Object.freeze(['main', 'sidebar']);

export const ANNOTATION_ID_PATTERN = /^a[1-9][0-9]{0,15}$/u;

export const ANNOTATION_HEX_PATTERN = /^#[0-9a-fA-F]{6}$/u;

export const ANNOTATION_UUID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/u;

export const ANNOTATION_DIGEST_PATTERN = /^[0-9a-f]{64}$/u;
/** Exactly these keys are accepted; anything else is INVALID_ARGUMENT (no silent extras). */

/** Exactly these keys are accepted; anything else is INVALID_ARGUMENT (no silent extras). */
export const ANNOTATION_PUBLISH_FIELDS = Object.freeze([
  'version', 'panelId', 'surface', 'clientRevision', 'context', 'view', 'shapes', 'truncation', 'release',
]);

export const ANNOTATION_CONTEXT_FIELDS = Object.freeze([
  'runtimeId', 'pageGeneration', 'documentEpoch', 'documentKey', 'addressDigest',
]);

export const ANNOTATION_VIEW_FIELDS = Object.freeze([
  'canvasX', 'canvasY', 'x', 'y', 'width', 'height', 'scale',
  'contentWidth', 'contentHeight', 'viewRevision', 'frameEpoch',
]);

export const ANNOTATION_TRUNCATION_FIELDS = Object.freeze(['droppedShapes', 'droppedPoints', 'shortenedTextCodeUnits']);

export const ANNOTATION_COMMON_FIELDS = Object.freeze(['id', 'type', 'color', 'strokeWidth', 'fill', 'stroke']);

export const ANNOTATION_GEOMETRY_FIELDS = Object.freeze({
  rect: Object.freeze(['x', 'y', 'width', 'height']),
  circle: Object.freeze(['cx', 'cy', 'rx', 'ry']),
  line: Object.freeze(['x1', 'y1', 'x2', 'y2']),
  arrow: Object.freeze(['x1', 'y1', 'x2', 'y2', 'head']),
  brush: Object.freeze(['points']),
  text: Object.freeze(['x', 'y', 'fontSize', 'text']),
});
/** JSON.parse keeps `__proto__` as an own key; those keys are refused instead of interpreted. */

/** JSON.parse keeps `__proto__` as an own key; those keys are refused instead of interpreted. */
export const ANNOTATION_POLLUTION_KEYS = Object.freeze(['__proto__', 'constructor', 'prototype']);

/** Numeric limits advertised by `browser_capabilities.limits.annotations`. */

/** Numeric limits advertised by `browser_capabilities.limits.annotations`. */
export function annotationLimits() {
  return {
    maxShapes: ANNOTATION_LIMITS.maxShapes,
    maxPointsPerShape: ANNOTATION_LIMITS.maxPointsPerShape,
    maxPointsPerDocument: ANNOTATION_LIMITS.maxPointsPerDocument,
    maxTextCodeUnits: ANNOTATION_LIMITS.maxTextCodeUnits,
    maxDocumentBytes: ANNOTATION_LIMITS.maxDocumentBytes,
    maxBodyBytes: ANNOTATION_LIMITS.maxBodyBytes,
    maxPanels: ANNOTATION_LIMITS.maxPanels,
    staleAfterMs: ANNOTATION_LIMITS.staleAfterMs,
    maxShapesPerCall: ANNOTATION_AGENT_MAX_SHAPES_PER_CALL,
    foregroundTtlMs: ANNOTATION_FOREGROUND_TTL_MS,
  };
}

/** One refusal vocabulary for the annotation write surface: field/reason/limits only, no echo. */

/** One refusal vocabulary for the annotation write surface: field/reason/limits only, no echo. */
export function annotationInvalid(field, reason) {
  return new BrowserError('INVALID_ARGUMENT', `标注发布不合法：${field} (${reason})`, {
    field, reason, limits: annotationLimits(),
  });
}

/** The documentKey/代次 no longer name the current document: 409, zero writes (§11.2). */

/** The documentKey/代次 no longer name the current document: 409, zero writes (§11.2). */
export function annotationStale() {
  return new BrowserError('INVALID_ARGUMENT', '标注上下文已过期：请读取最新 ui.annotationContext 后重新发布', {
    field: 'context', reason: 'annotation-context-stale', limits: annotationLimits(),
  });
}

export function annotationNumber(value, field, {
  min = -Infinity, max = Infinity, integer = false, exclusiveMin = false, nullable = false,
} = {}) {
  if (value === null || value === undefined) {
    if (nullable) return null;
    throw annotationInvalid(field, 'not-a-number');
  }
  if (typeof value !== 'number' || !Number.isFinite(value)) throw annotationInvalid(field, 'not-finite');
  const number = value === 0 ? 0 : value; // `-0` normalizes to 0 (§11.2)
  if (integer && !Number.isSafeInteger(number)) throw annotationInvalid(field, 'not-an-integer');
  if (exclusiveMin ? number <= min : number < min) throw annotationInvalid(field, 'out-of-range');
  if (number > max) throw annotationInvalid(field, 'out-of-range');
  return number;
}

export function annotationBoolean(value, field) {
  if (typeof value !== 'boolean') throw annotationInvalid(field, 'not-a-boolean');
  return value;
}

export function annotationString(value, field, maxLength) {
  if (typeof value !== 'string' || !value) throw annotationInvalid(field, 'not-a-string');
  if (value.length > maxLength) throw annotationInvalid(field, 'too-long');
  return value;
}

/** Strict plain-object check: prototype pollution and class instances are refused up front. */

/** Strict plain-object check: prototype pollution and class instances are refused up front. */
export function annotationObject(value, field) {
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw annotationInvalid(field, 'not-an-object');
  const prototype = Object.getPrototypeOf(value);
  if (prototype !== Object.prototype && prototype !== null) throw annotationInvalid(field, 'not-a-plain-object');
  for (const key of Object.keys(value)) {
    if (ANNOTATION_POLLUTION_KEYS.includes(key)) throw annotationInvalid(field, 'prototype-pollution');
  }
  return value;
}

export function annotationRejectUnknown(value, allowed, field) {
  for (const key of Object.keys(value)) {
    if (!allowed.includes(key)) throw annotationInvalid(`${field}.${key}`, 'unknown-field');
  }
}

/** Trim to `budget` UTF-16 code units without ever splitting a surrogate pair. */

/** Trim to `budget` UTF-16 code units without ever splitting a surrogate pair. */
export function annotationTrimText(text, budget) {
  if (text.length <= budget) return { text, removed: 0 };
  let cut = budget;
  const last = text.charCodeAt(cut - 1);
  if (last >= 0xd800 && last <= 0xdbff) cut -= 1;
  return { text: text.slice(0, cut), removed: text.length - cut };
}

/** Uniform downsample that always keeps the first and the last point (both sides compute this). */

/** Uniform downsample that always keeps the first and the last point (both sides compute this). */
export function annotationDownsample(points, maxPoints) {
  const count = points.length;
  if (count <= maxPoints) return { points, removed: 0 };
  const kept = [];
  for (let index = 0; index < maxPoints; index += 1) {
    kept.push(points[Math.round((index * (count - 1)) / (maxPoints - 1))]);
  }
  return { points: kept, removed: count - maxPoints };
}

/** The Host recomputes the arrow head from the endpoints and the stroke width (§11.2). */

/** The Host recomputes the arrow head from the endpoints and the stroke width (§11.2). */
export function annotationArrowHead(shape) {
  const length = Math.hypot(shape.x2 - shape.x1, shape.y2 - shape.y1);
  return {
    length: Math.min(3 * shape.strokeWidth, length),
    width: Math.min(2 * shape.strokeWidth, length),
  };
}

export function normalizeAnnotationShape(raw, field, seenIds) {
  const shape = annotationObject(raw, field);
  const type = shape.type;
  if (typeof type !== 'string' || !ANNOTATION_TYPES.includes(type)) throw annotationInvalid(`${field}.type`, 'invalid-enum');
  annotationRejectUnknown(shape, [...ANNOTATION_COMMON_FIELDS, ...ANNOTATION_GEOMETRY_FIELDS[type]], field);
  if (typeof shape.id !== 'string' || !ANNOTATION_ID_PATTERN.test(shape.id)) throw annotationInvalid(`${field}.id`, 'invalid-id');
  if (seenIds.has(shape.id)) throw annotationInvalid(`${field}.id`, 'duplicate-id');
  seenIds.add(shape.id);
  if (typeof shape.color !== 'string' || !ANNOTATION_HEX_PATTERN.test(shape.color)) throw annotationInvalid(`${field}.color`, 'invalid-color');
  const strokeWidth = annotationNumber(shape.strokeWidth, `${field}.strokeWidth`, {
    min: ANNOTATION_LIMITS.strokeWidth[0], max: ANNOTATION_LIMITS.strokeWidth[1], integer: true,
  });
  const fill = annotationBoolean(shape.fill, `${field}.fill`);
  const stroke = annotationBoolean(shape.stroke, `${field}.stroke`);
  if (type === 'line' || type === 'arrow' || type === 'brush') {
    if (fill !== false || stroke !== true) throw annotationInvalid(`${field}.fill`, 'fill-stroke-fixed');
  } else if (type === 'text') {
    if (fill !== true || stroke !== false) throw annotationInvalid(`${field}.fill`, 'fill-stroke-fixed');
  } else if (!fill && !stroke) {
    throw annotationInvalid(`${field}.fill`, 'fill-stroke-empty');
  }
  const coord = (value, name) => annotationNumber(value, `${field}.${name}`, {
    min: ANNOTATION_COORD_MIN, max: ANNOTATION_COORD_MAX,
  });
  const normalized = {
    id: shape.id,
    type,
    // The contract fixes lowercase six-digit hex; an upper-case client value is normalized once.
    color: shape.color.toLowerCase(),
    strokeWidth,
    fill,
    stroke,
  };
  let shortenedText = 0;
  if (type === 'rect') {
    normalized.x = coord(shape.x, 'x');
    normalized.y = coord(shape.y, 'y');
    normalized.width = annotationNumber(shape.width, `${field}.width`, { min: 0, max: ANNOTATION_RECT_SIZE_MAX, exclusiveMin: true });
    normalized.height = annotationNumber(shape.height, `${field}.height`, { min: 0, max: ANNOTATION_RECT_SIZE_MAX, exclusiveMin: true });
  } else if (type === 'circle') {
    normalized.cx = coord(shape.cx, 'cx');
    normalized.cy = coord(shape.cy, 'cy');
    normalized.rx = annotationNumber(shape.rx, `${field}.rx`, { min: 0, max: ANNOTATION_ELLIPSE_RADIUS_MAX, exclusiveMin: true });
    normalized.ry = annotationNumber(shape.ry, `${field}.ry`, { min: 0, max: ANNOTATION_ELLIPSE_RADIUS_MAX, exclusiveMin: true });
  } else if (type === 'line' || type === 'arrow') {
    normalized.x1 = coord(shape.x1, 'x1');
    normalized.y1 = coord(shape.y1, 'y1');
    normalized.x2 = coord(shape.x2, 'x2');
    normalized.y2 = coord(shape.y2, 'y2');
    if (normalized.x1 === normalized.x2 && normalized.y1 === normalized.y2) throw annotationInvalid(`${field}.x2`, 'degenerate-endpoints');
    if (type === 'arrow') {
      if (shape.head !== undefined && shape.head !== null) annotationObject(shape.head, `${field}.head`);
      // Never trust a client head: it is derived from the endpoints + stroke width only.
      normalized.head = annotationArrowHead(normalized);
    }
  } else if (type === 'brush') {
    if (!Array.isArray(shape.points) || shape.points.length < 2) throw annotationInvalid(`${field}.points`, 'too-few-points');
    const points = [];
    for (let index = 0; index < shape.points.length; index += 1) {
      const pair = shape.points[index];
      if (!Array.isArray(pair) || pair.length !== 2) throw annotationInvalid(`${field}.points[${index}]`, 'invalid-point');
      points.push([
        coord(pair[0], `points[${index}][0]`),
        coord(pair[1], `points[${index}][1]`),
      ]);
    }
    normalized.points = points;
  } else {
    normalized.x = coord(shape.x, 'x');
    normalized.y = coord(shape.y, 'y');
    const fontSize = annotationNumber(shape.fontSize, `${field}.fontSize`, { min: 1, max: 4096, integer: true });
    if (fontSize !== ANNOTATION_LIMITS.textFontSize) throw annotationInvalid(`${field}.fontSize`, 'font-size-fixed');
    normalized.fontSize = fontSize;
    if (typeof shape.text !== 'string') throw annotationInvalid(`${field}.text`, 'not-a-string');
    const trimmed = annotationTrimText(shape.text, ANNOTATION_LIMITS.maxTextCodeUnits);
    normalized.text = trimmed.text;
    shortenedText = trimmed.removed;
  }
  return { shape: normalized, shortenedText };
}

export function normalizeAnnotationView(raw) {
  const view = annotationObject(raw, 'view');
  annotationRejectUnknown(view, ANNOTATION_VIEW_FIELDS, 'view');
  return {
    canvasX: annotationNumber(view.canvasX, 'view.canvasX', { min: -10000000, max: 10000000 }),
    canvasY: annotationNumber(view.canvasY, 'view.canvasY', { min: -10000000, max: 10000000 }),
    x: annotationNumber(view.x, 'view.x', { min: -10000000, max: 10000000 }),
    y: annotationNumber(view.y, 'view.y', { min: -10000000, max: 10000000 }),
    width: annotationNumber(view.width, 'view.width', { min: 200, max: 4096, integer: true }),
    height: annotationNumber(view.height, 'view.height', { min: 200, max: 4096, integer: true }),
    scale: annotationNumber(view.scale, 'view.scale', { min: 0.1, max: 2 }),
    contentWidth: annotationNumber(view.contentWidth, 'view.contentWidth', { min: 0, max: Number.MAX_SAFE_INTEGER, nullable: true }),
    contentHeight: annotationNumber(view.contentHeight, 'view.contentHeight', { min: 0, max: Number.MAX_SAFE_INTEGER, nullable: true }),
    viewRevision: annotationNumber(view.viewRevision, 'view.viewRevision', { min: 0, max: Number.MAX_SAFE_INTEGER, integer: true }),
    frameEpoch: annotationNumber(view.frameEpoch, 'view.frameEpoch', { min: 0, max: Number.MAX_SAFE_INTEGER, integer: true, nullable: true }),
  };
}

export function normalizeAnnotationTruncation(raw) {
  const zeros = { droppedShapes: 0, droppedPoints: 0, shortenedTextCodeUnits: 0 };
  if (raw === undefined || raw === null) return zeros;
  const truncation = annotationObject(raw, 'truncation');
  annotationRejectUnknown(truncation, ANNOTATION_TRUNCATION_FIELDS, 'truncation');
  for (const key of ANNOTATION_TRUNCATION_FIELDS) {
    zeros[key] = annotationNumber(truncation[key], `truncation.${key}`, {
      min: 0, max: Number.MAX_SAFE_INTEGER, integer: true,
    });
  }
  return zeros;
}

/** Strict pre-flight of one publish body; only whitelisted, typed, in-range values survive. */

/** Strict pre-flight of one publish body; only whitelisted, typed, in-range values survive. */
export function normalizeAnnotationPublish(body) {
  const publish = annotationObject(body, 'annotations');
  annotationRejectUnknown(publish, ANNOTATION_PUBLISH_FIELDS, 'annotations');
  if (publish.version !== ANNOTATION_VERSION) throw annotationInvalid('version', 'unsupported-version');
  const panelId = annotationString(publish.panelId, 'panelId', 64).toLowerCase();
  if (!ANNOTATION_UUID_PATTERN.test(panelId)) throw annotationInvalid('panelId', 'invalid-panel-id');
  if (typeof publish.surface !== 'string' || !ANNOTATION_SURFACES.includes(publish.surface)) throw annotationInvalid('surface', 'invalid-enum');
  const clientRevision = annotationNumber(publish.clientRevision, 'clientRevision', {
    min: 1, max: Number.MAX_SAFE_INTEGER, integer: true,
  });
  const release = publish.release === undefined || publish.release === null
    ? false
    : annotationBoolean(publish.release, 'release');
  const context = annotationObject(publish.context, 'context');
  annotationRejectUnknown(context, ANNOTATION_CONTEXT_FIELDS, 'context');
  const normalizedContext = {
    runtimeId: annotationString(context.runtimeId, 'context.runtimeId', 64),
    pageGeneration: annotationNumber(context.pageGeneration, 'context.pageGeneration', {
      min: 0, max: Number.MAX_SAFE_INTEGER, integer: true, nullable: true,
    }),
    documentEpoch: annotationNumber(context.documentEpoch, 'context.documentEpoch', {
      min: 0, max: Number.MAX_SAFE_INTEGER, integer: true, nullable: true,
    }),
    documentKey: annotationString(context.documentKey, 'context.documentKey', 128),
    addressDigest: annotationString(context.addressDigest, 'context.addressDigest', 64),
  };
  if (!ANNOTATION_DIGEST_PATTERN.test(normalizedContext.addressDigest)) throw annotationInvalid('context.addressDigest', 'invalid-digest');
  const view = normalizeAnnotationView(publish.view);
  const rawShapes = publish.shapes === undefined || publish.shapes === null ? [] : publish.shapes;
  if (!Array.isArray(rawShapes)) throw annotationInvalid('shapes', 'not-an-array');
  if (release && rawShapes.length > 0) throw annotationInvalid('shapes', 'release-requires-empty-shapes');
  const seenIds = new Set();
  const shapes = [];
  let shortenedText = 0;
  for (let index = 0; index < rawShapes.length; index += 1) {
    const result = normalizeAnnotationShape(rawShapes[index], `shapes[${index}]`, seenIds);
    shapes.push(result.shape);
    shortenedText += result.shortenedText;
  }
  return {
    panelId,
    surface: publish.surface,
    clientRevision,
    release,
    context: normalizedContext,
    view,
    shapes,
    truncation: normalizeAnnotationTruncation(publish.truncation),
    shortenedText,
  };
}

/** The soft limits, applied to an already normalized shape list (docs/viewport-control.md). */

/** The soft limits, applied to an already normalized shape list (docs/viewport-control.md). */
export function applyAnnotationLimits(shapes, clientTruncation, shortenedText) {
  const truncation = {
    droppedShapes: clientTruncation.droppedShapes,
    droppedPoints: clientTruncation.droppedPoints,
    shortenedTextCodeUnits: clientTruncation.shortenedTextCodeUnits + (shortenedText || 0),
  };
  let list = shapes;
  if (list.length > ANNOTATION_LIMITS.maxShapes) {
    truncation.droppedShapes += list.length - ANNOTATION_LIMITS.maxShapes;
    list = list.slice(list.length - ANNOTATION_LIMITS.maxShapes);
  }
  list = list.map((shape) => {
    if (shape.type !== 'brush') return shape;
    const downsampled = annotationDownsample(shape.points, ANNOTATION_LIMITS.maxPointsPerShape);
    truncation.droppedPoints += downsampled.removed;
    return downsampled.removed > 0 ? { ...shape, points: downsampled.points } : shape;
  });
  const totalPoints = () => list.reduce((sum, shape) => sum + (shape.type === 'brush' ? shape.points.length : 0), 0);
  while (list.length > 0 && totalPoints() > ANNOTATION_LIMITS.maxPointsPerDocument) {
    list = list.slice(1);
    truncation.droppedShapes += 1;
  }
  return { shapes: list, truncation };
}

/**
 * Agent annotation write surface — pure pre-flight, no browser, no CDP, no file
 * (docs/viewport-control.md).
 *
 * `browser_annotation` writes the SAME document the human panel publishes, so both writers have to
 * agree on one set of shapes and one limit application. Everything below is deterministic data
 * handling: an invalid call costs nothing, and a shape that would not survive the panel's own
 * `annotWireShape`/Host validation is refused here instead of being drawn differently later.
 */

export const ANNOTATION_AGENT_SHAPE_FIELDS = Object.freeze([
  'type', 'id', 'color', 'strokeWidth', 'style', 'fill', 'stroke',
  'x', 'y', 'width', 'height', 'cx', 'cy', 'rx', 'ry', 'x1', 'y1', 'x2', 'y2', 'points', 'text', 'fontSize',
]);

/** Next free `a<N>` id, starting after every id already in the document and in this call. */

/** Next free `a<N>` id, starting after every id already in the document and in this call. */
export function annotationAgentIdFactory(shapes, specs) {
  let max = 0;
  const consider = (id) => {
    const match = typeof id === 'string' ? /^a([1-9][0-9]{0,15})$/u.exec(id) : null;
    if (!match) return;
    const numeric = Number(match[1]);
    if (Number.isSafeInteger(numeric) && numeric > max) max = numeric;
  };
  for (const shape of shapes) consider(shape && shape.id);
  for (const spec of specs) consider(spec && typeof spec === 'object' && !Array.isArray(spec) ? spec.id : null);
  return () => { max += 1; return 'a' + max; };
}

/**
 * 填充/外框 for one Agent shape. `style` is the panel's single-source mode; explicit
 * `fill`/`stroke` booleans are accepted for callers that want the raw contract, but mixing both is
 * refused instead of guessed (a silently ignored style would draw a different shape).
 */

export function annotationAgentFillStroke(type, spec, field) {
  const hasStyle = spec.style !== undefined && spec.style !== null;
  const hasFlags = spec.fill !== undefined || spec.stroke !== undefined;
  if (hasStyle && hasFlags) throw annotationInvalid(`${field}.style`, 'style-conflicts-fill-stroke');
  if (hasStyle) {
    if (spec.style !== 'fill' && spec.style !== 'stroke') throw annotationInvalid(`${field}.style`, 'invalid-enum');
    // `外框` is the panel's default mode for closed tools (annotStyleFor in client.js).
    return spec.style === 'fill' ? { fill: true, stroke: false } : { fill: false, stroke: true };
  }
  if (hasFlags) {
    return {
      fill: spec.fill === undefined ? false : annotationBoolean(spec.fill, `${field}.fill`),
      stroke: spec.stroke === undefined ? false : annotationBoolean(spec.stroke, `${field}.stroke`),
    };
  }
  // Panel defaults: text is filled text; free strokes/arrows are always outer strokes; circle and
  // rect follow the panel's default 外框 mode.
  return type === 'text' ? { fill: true, stroke: false } : { fill: false, stroke: true };
}

/** One Agent shape spec → the wire shape the panel and the screenshot overlay already understand. */

/** One Agent shape spec → the wire shape the panel and the screenshot overlay already understand. */
export function normalizeAgentAnnotationShape(raw, field, allocateId, seenIds) {
  const spec = annotationObject(raw, field);
  annotationRejectUnknown(spec, ANNOTATION_AGENT_SHAPE_FIELDS, field);
  const type = spec.type;
  if (typeof type !== 'string' || !ANNOTATION_TYPES.includes(type)) throw annotationInvalid(`${field}.type`, 'invalid-enum');
  const style = annotationAgentFillStroke(type, spec, field);
  const wire = {
    id: spec.id === undefined || spec.id === null ? allocateId() : spec.id,
    type,
    color: spec.color === undefined || spec.color === null ? ANNOTATION_AGENT_DEFAULT_COLOR : spec.color,
    strokeWidth: spec.strokeWidth === undefined || spec.strokeWidth === null
      ? ANNOTATION_AGENT_DEFAULT_STROKE : spec.strokeWidth,
    fill: style.fill,
    stroke: style.stroke,
  };
  for (const key of ANNOTATION_GEOMETRY_FIELDS[type]) {
    // The arrow head is derived from the endpoints + stroke width; a supplied head never wins.
    if (key === 'head') continue;
    if (key === 'fontSize') {
      wire.fontSize = spec.fontSize === undefined || spec.fontSize === null
        ? ANNOTATION_LIMITS.textFontSize : spec.fontSize;
      continue;
    }
    wire[key] = spec[key];
  }
  return normalizeAnnotationShape(wire, field, seenIds);
}

export function annotationSegmentDistance(px, py, ax, ay, bx, by) {
  const dx = bx - ax;
  const dy = by - ay;
  const lengthSq = dx * dx + dy * dy;
  if (!(lengthSq > 0)) return Math.hypot(px - ax, py - ay);
  const t = Math.max(0, Math.min(1, ((px - ax) * dx + (py - ay) * dy) / lengthSq));
  return Math.hypot(px - (ax + t * dx), py - (ay + t * dy));
}

export function annotationPointInRect(point, rect) {
  return point.x >= rect.x && point.x <= rect.x + rect.width
    && point.y >= rect.y && point.y <= rect.y + rect.height;
}

/** Distance from a point to a rect's outline (inside included): 0 on the border. */

/** Distance from a point to a rect's outline (inside included): 0 on the border. */
export function annotationRectOutlineDistance(point, rect) {
  const left = rect.x;
  const right = rect.x + rect.width;
  const top = rect.y;
  const bottom = rect.y + rect.height;
  if (!annotationPointInRect(point, rect)) {
    const nx = Math.min(Math.max(point.x, left), right);
    const ny = Math.min(Math.max(point.y, top), bottom);
    return Math.hypot(point.x - nx, point.y - ny);
  }
  return Math.min(point.x - left, right - point.x, point.y - top, bottom - point.y);
}

/**
 * Host-side eraser hit test (the panel uses Path2D/isPointInStroke plus the rendered text bbox; the
 * Host must not read the page, so the rules below are analytic and stated in the docs):
 *   rect   — inside when filled, else within `r` of the outline;
 *   circle — normalized radial distance |k−1| · min(rx,ry) within `r`, inside when filled;
 *   line   — point/segment distance within `r`;
 *   arrow  — the shaft only (the head triangle is not modelled);
 *   brush  — nearest polyline segment within `r`;
 *   text   — an estimated box (see ANNOTATION_TEXT_BOX_CHAR_RATIO), expanded by `r`.
 * `r = max(requested radius, strokeWidth / 2, 6)` mirrors `annotEraseRadius` in client.js.
 */

export function annotationAgentHit(shape, point, radius) {
  const width = Number(shape.strokeWidth);
  const limit = Math.max(radius, Number.isFinite(width) ? width / 2 : 0, ANNOTATION_ERASE_MIN_RADIUS);
  if (shape.type === 'rect') {
    const rect = { x: shape.x, y: shape.y, width: shape.width, height: shape.height };
    if (shape.fill === true && annotationPointInRect(point, rect)) return true;
    if (shape.stroke !== true) return false;
    return annotationRectOutlineDistance(point, rect) <= limit;
  }
  if (shape.type === 'circle') {
    const rx = shape.rx;
    const ry = shape.ry;
    const k = Math.hypot((point.x - shape.cx) / rx, (point.y - shape.cy) / ry);
    if (shape.fill === true && k <= 1) return true;
    if (shape.stroke !== true) return false;
    return Math.abs(k - 1) * Math.min(rx, ry) <= limit;
  }
  if (shape.type === 'line' || shape.type === 'arrow') {
    return annotationSegmentDistance(point.x, point.y, shape.x1, shape.y1, shape.x2, shape.y2) <= limit;
  }
  if (shape.type === 'brush') {
    const points = Array.isArray(shape.points) ? shape.points : [];
    if (points.length === 1) return Math.hypot(point.x - points[0][0], point.y - points[0][1]) <= limit;
    for (let index = 1; index < points.length; index += 1) {
      if (annotationSegmentDistance(point.x, point.y, points[index - 1][0], points[index - 1][1],
        points[index][0], points[index][1]) <= limit) return true;
    }
    return false;
  }
  if (shape.type === 'text') {
    const size = Number(shape.fontSize);
    const fontSize = Number.isFinite(size) && size > 0 ? size : ANNOTATION_LIMITS.textFontSize;
    const chars = Math.max(1, String(shape.text || '').length);
    const rect = {
      x: shape.x,
      y: shape.y - fontSize,
      width: chars * fontSize * ANNOTATION_TEXT_BOX_CHAR_RATIO,
      height: fontSize * 1.2,
    };
    return annotationRectOutlineDistance(point, rect) <= limit || annotationPointInRect(point, rect);
  }
  return false;
}

/**
 * `browser_annotation` arguments → one validated call. Pure: no runtime, no browser, no file, so an
 * invalid call is refused before any state is read (and before the foreground claim is consulted).
 */

export function normalizeAgentAnnotationCall(args) {
  const input = annotationObject(args, 'browser_annotation');
  annotationRejectUnknown(input,
    ['action', 'shapes', 'ids', 'point', 'expectRevision'], 'browser_annotation');
  const action = input.action;
  if (typeof action !== 'string' || !ANNOTATION_AGENT_ACTIONS.includes(action)) {
    throw annotationInvalid('action', 'invalid-enum');
  }
  const allowed = {
    read: [],
    draw: ['shapes', 'expectRevision'],
    erase: ['ids', 'point', 'expectRevision'],
    clear: ['expectRevision'],
  }[action];
  for (const key of Object.keys(input)) {
    if (key === 'action') continue;
    if (!allowed.includes(key)) throw annotationInvalid(key, 'unknown-field');
  }
  let expectRevision = null;
  if (input.expectRevision !== undefined && input.expectRevision !== null) {
    expectRevision = annotationNumber(input.expectRevision, 'expectRevision', {
      min: 0, max: Number.MAX_SAFE_INTEGER, integer: true,
    });
  }
  if (action === 'read') return { action, specs: [], ids: [], point: null, expectRevision };
  if (action === 'clear') return { action, specs: [], ids: [], point: null, expectRevision };
  if (action === 'draw') {
    if (!Array.isArray(input.shapes) || input.shapes.length === 0) throw annotationInvalid('shapes', 'not-an-array');
    if (input.shapes.length > ANNOTATION_AGENT_MAX_SHAPES_PER_CALL) throw annotationInvalid('shapes', 'too-many');
    return { action, specs: input.shapes, ids: [], point: null, expectRevision };
  }
  // erase: ids and/or a point hit. Both empty would be a no-op reported as success — refuse it.
  const ids = [];
  if (input.ids !== undefined && input.ids !== null) {
    if (!Array.isArray(input.ids)) throw annotationInvalid('ids', 'not-an-array');
    if (input.ids.length > ANNOTATION_AGENT_MAX_SHAPES_PER_CALL) throw annotationInvalid('ids', 'too-many');
    for (let index = 0; index < input.ids.length; index += 1) {
      const id = input.ids[index];
      if (typeof id !== 'string' || !ANNOTATION_ID_PATTERN.test(id)) throw annotationInvalid(`ids[${index}]`, 'invalid-id');
      if (ids.includes(id)) throw annotationInvalid(`ids[${index}]`, 'duplicate-id');
      ids.push(id);
    }
  }
  let point = null;
  if (input.point !== undefined && input.point !== null) {
    const raw = annotationObject(input.point, 'point');
    annotationRejectUnknown(raw, ['x', 'y', 'radius'], 'point');
    const coord = (value, name) => annotationNumber(value, `point.${name}`, {
      min: ANNOTATION_COORD_MIN, max: ANNOTATION_COORD_MAX,
    });
    point = {
      x: coord(raw.x, 'x'),
      y: coord(raw.y, 'y'),
      radius: raw.radius === undefined || raw.radius === null
        ? ANNOTATION_ERASE_DEFAULT_RADIUS
        : annotationNumber(raw.radius, 'point.radius', { min: 1, max: 4096 }),
    };
  }
  if (ids.length === 0 && point === null) throw annotationInvalid('ids', 'erase-target-required');
  return { action, specs: [], ids, point, expectRevision };
}

/** Content digest of one panel revision: the same revision must carry the same content. */

/** Content digest of one panel revision: the same revision must carry the same content. */
export function annotationDigest(request) {
  return createHash('sha256').update(JSON.stringify({
    surface: request.surface,
    release: request.release,
    view: request.view,
    shapes: request.shapes,
    truncation: request.truncation,
  })).digest('hex');
}

/**
 * Bounded body read for the annotation route only (docs/viewport-control.md): the hard limit
 * is 262144 bytes and every other route keeps its historical 8MiB `readJson`.
 */

export function readAnnotationBody(req, maxBytes) {
  return new Promise((resolve, reject) => {
    const chunks = [];
    let size = 0;
    let settled = false;
    const finish = (settle, value) => { if (settled) return; settled = true; settle(value); };
    req.on('data', (chunk) => {
      if (settled) return;
      size += chunk.length;
      if (size > maxBytes) {
        finish(reject, annotationInvalid('body', 'annotation-body-too-large'));
        try { req.destroy?.(); } catch { /* already gone */ }
        return;
      }
      chunks.push(chunk);
    });
    req.on('end', () => {
      if (settled) return;
      const text = Buffer.concat(chunks).toString('utf8');
      if (!text) { finish(reject, annotationInvalid('body', 'annotation-body-empty')); return; }
      let parsed;
      try { parsed = JSON.parse(text); } catch { finish(reject, annotationInvalid('body', 'annotation-body-not-json')); return; }
      finish(resolve, parsed);
    });
    req.on('error', (error) => finish(reject, asBrowserError(error)));
  });
}

/**
 * Pick one loopback port that is free on both 127.0.0.1 and ::1 (when IPv6 exists).
 *
 * The contract requires holding both probe sockets until the probe is finished and closing them
 * before spawn. There is an unavoidable TOCTOU window between close and Chrome's bind; this is a
 * candidate picker, not a port reservation. If ::1 is occupied the whole candidate is rejected
 * (another debugger already owns it); a platform without IPv6 degrades explicitly to IPv4-only.
 */

export async function probeLoopbackDevtoolsPort() {
  const ipv4 = await new Promise((resolve) => {
    const server = net.createServer();
    server.unref();
    server.once('error', (error) => resolve({ server: null, error }));
    server.listen(0, '127.0.0.1', () => resolve({ server, port: server.address().port }));
  });
  if (!ipv4.server) return { port: 0, ipv6: false, error: ipv4.error };
  const port = ipv4.port;
  const ipv6 = await new Promise((resolve) => {
    const server = net.createServer();
    server.unref();
    server.once('error', (error) => resolve({ server: null, error }));
    server.listen(port, '::1', () => resolve({ server }));
  });
  await new Promise((resolve) => ipv4.server.close(resolve));
  if (ipv6.server) await new Promise((resolve) => ipv6.server.close(resolve));
  if (ipv6.error) {
    const code = ipv6.error.code;
    if (['EAFNOSUPPORT', 'EADDRNOTAVAIL', 'EPROTONOSUPPORT', 'EINVAL'].includes(code)) return { port, ipv6: false };
    return { port: 0, ipv6: false, error: ipv6.error };
  }
  return { port, ipv6: true };
}

/** True when a /proc/net/tcp{,6} listening address is a loopback address (never 0.0.0.0/::). */

/** True when a /proc/net/tcp{,6} listening address is a loopback address (never 0.0.0.0/::). */
export function isLoopbackProcAddress(addressHex, ipv6) {
  if (!ipv6) return /^[0-9A-Fa-f]{6}7F$/.test(addressHex); // 127.0.0.0/8 (little-endian word)
  if (addressHex.length !== 32) return false;
  if (addressHex === '00000000000000000000000001000000') return true; // ::1
  return /^0{16}FFFF0000[0-9A-Fa-f]{6}7F$/.test(addressHex); // ::ffff:127.0.0.0/8
}

/**
 * Measure the real listener address instead of trusting `--remote-debugging-address`.
 * Returns 'loopback' | 'external' | 'unknown' | 'unavailable' (no /proc on this platform).
 */

export async function inspectLoopbackListener(port) {
  let inspected = false;
  let loopback = false;
  for (const [file, ipv6] of [['/proc/net/tcp', false], ['/proc/net/tcp6', true]]) {
    let text;
    try { text = await readFile(file, 'utf8'); } catch { continue; }
    inspected = true;
    for (const line of text.split('\n').slice(1)) {
      const fields = line.trim().split(/\s+/);
      if (fields.length < 4 || fields[3] !== '0A') continue; // TCP_LISTEN
      const local = fields[1];
      const separator = local.lastIndexOf(':');
      if (separator < 0) continue;
      if (Number.parseInt(local.slice(separator + 1), 16) !== port) continue;
      if (!isLoopbackProcAddress(local.slice(0, separator), ipv6)) return 'external';
      loopback = true;
    }
  }
  if (loopback) return 'loopback';
  return inspected ? 'unknown' : 'unavailable';
}

/**
 * Parse a browser-level CDP endpoint from `webSocketDebuggerUrl` or a stderr identity line.
 * Only ws, loopback host (normalised forms accepted), the exact expected port and
 * `/devtools/browser/<id>` are accepted; no credentials, query or fragment.
 */

export function parseDevtoolsBrowserEndpoint(raw, expectedPort) {
  if (typeof raw !== 'string' || !raw) return null;
  let url;
  try { url = new URL(raw); } catch { return null; }
  if (url.protocol !== 'ws:') return null;
  if (url.username || url.password || url.search || url.hash) return null;
  const host = url.hostname.replace(/^\[|\]$/g, '').toLowerCase();
  if (!['127.0.0.1', 'localhost', '::1'].includes(host)) return null;
  if (Number(url.port) !== expectedPort) return null;
  const match = /^\/devtools\/browser\/([A-Za-z0-9._-]{8,128})$/.exec(url.pathname);
  if (!match) return null;
  return { browserId: match[1], pathname: url.pathname, port: expectedPort };
}

/** Startup failure with the fixed detail enum from the contract (§2.3). */

/** Startup failure with the fixed detail enum from the contract (§2.3). */
export function devtoolsStartupError(reason, attempts, extra = {}) {
  const messages = {
    'port-unavailable': '没有可用的 loopback 调试端口（端口冲突或仅 IPv6 可用）',
    'endpoint-mismatch': '调试端口返回了其他进程的端点',
    'debugger-not-ready': 'Chromium 调试端点未在预期时间内就绪',
  };
  const code = reason === 'debugger-not-ready' ? 'CDP_TIMEOUT' : 'CDP_DISCONNECTED';
  return new BrowserError(code, messages[reason] || 'Chromium 调试端点启动失败', {
    phase: 'startup', reason, attempts, ...extra,
  });
}

/**
 * One headless Chromium + temporary profile for the whole plugin, with N independent page targets.
 *
 * Popup interception is unchanged: extra page targets that are not owned by a Runtime are paused
 * via auto-attach, have Fetch fail-all installed, then are resumed and closed.
 */
/** True for the popup documents that carry no settleable URL (about:blank/data/blob/js). */
export function isBlankPageUrl(value) {
  return !value || /^(about:blank|data:|blob:|javascript:)/i.test(String(value));
}

export class BrowserHost {
  constructor(log, options = {}) {
    this.log = log;
    this.proc = undefined;
    /** Runtime provider this host launches (chrome|edge); set by the registry, never by tools. */
    this.provider = options?.provider ?? 'chrome';
    this.product = null;
    this.executablePath = null;
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
    /** Authenticated GUI mouse/key tickets and Page.windowOpen intents (popup admission). */
    this.popupTickets = new Map();
    this.windowIntents = new Map();
    this.popupInFlight = new Set();
    this.popupEventSeq = 0;
    this.initialTargetId = undefined;
    /** Log the explicit IPv4-only degradation once per host, not once per start attempt. */
    this.ipv6ProbeLogged = false;
    /** Headless by default; `headed` is the Web-view escape hatch (visible window + persistent profile). */
    this.displayMode = 'headless';
    /** True while the current profile must survive close (headed mode). */
    this.profilePersistent = false;
    /** Result of the most recent hide attempt for the current browser process. */
    this.windowHidden = false;
    /**
     * Which runtime last brought its page to the front of this browser.
     *
     * Front-ness is per browser window, not per runtime: tracking it here is what lets
     * `Runtime.activate()` answer "already front" without the per-runtime throttle that used to
     * skip the bringToFront an input dispatch depended on.
     */
    this.frontRuntimeId = undefined;
  }

  get pageCount() { return this.ownedTargets.size; }

  get running() { return Boolean(this.browserCdp && !this.browserCdp.closed); }

  get display() { return this.displayMode; }

  /** Headed runs offscreen by default (no visible window/task focus); env opts into a real window. */
  get displayWindow() {
    if (this.displayMode !== 'headed') return 'none';
    return process.env.DSH_UI_TESTING_HEADED_VISIBLE === '1' ? 'visible' : 'offscreen';
  }

  /** Hidden Linux browsers create their native windows without requesting desktop focus. */
  get backgroundHeaded() {
    return process.platform === 'linux' && this.displayWindow === 'offscreen';
  }

  /** Hide the native window while keeping it mapped for Chromium's compositor and input. */
  async #hideHeadedWindows(proc) {
    if (this.displayMode !== 'headed' || this.displayWindow === 'visible' || !proc?.pid) return;
    if (process.platform === 'win32') {
      // Restyling keeps the window "visible" to Chromium; see hideHeadedWindowWin32.
      if (hideHeadedWindowWin32(proc.pid)) this.windowHidden = true;
      return;
    }
    if (process.platform !== 'linux' || !process.env.DISPLAY) return;
    let hidden = false;
    try {
      const { hideHeadedWindowsX11 } = await import('./headed-x11.js');
      if (this.proc !== proc) return;
      hidden = await hideHeadedWindowsX11(proc.pid, process.env.DISPLAY);
    } catch { /* retain offscreen placement if the local X11 client is unavailable */ }
    if (this.proc === proc) this.windowHidden = hidden;
  }

  /**
   * Switch the shared Chromium between headless (default) and headed (Web view only). A running
   * browser cannot change flags in place: close it first, then let the next ensure spawn the new
   * mode. Headed needs a display server and keeps its profile across sessions (login/CF cookies).
   */
  async setDisplayMode(mode) {
    if (mode !== 'headless' && mode !== 'headed') {
      throw new BrowserError('INVALID_ARGUMENT', 'display mode 只支持 headless / headed', { mode });
    }
    // A Windows desktop always has a window system; DISPLAY/WAYLAND_DISPLAY is X11/Wayland only,
    // so gating on those two variables rejects headed mode on every Windows host.
    const windowSystem = process.platform === 'win32'
      || Boolean(process.env.DISPLAY) || Boolean(process.env.WAYLAND_DISPLAY);
    if (mode === 'headed' && !windowSystem) {
      throw new BrowserError('DISPLAY_UNAVAILABLE', '有头模式需要图形显示（DISPLAY/WAYLAND_DISPLAY）', { mode });
    }
    if (this.displayMode === mode) return this.displayMode;
    this.displayMode = mode;
    // Pages cannot survive the process swap: close now, the caller re-opens/ navigates explicitly.
    await this.close();
    return this.displayMode;
  }

  /** Stable profile for headed mode; headless keeps the disposable per-start temp profile. */
  headedProfileDir() {
    const override = process.env.DSH_UI_TESTING_PROFILE_DIR;
    if (override) return override;
    const home = process.env.DSH_HOME || join(homedir(), '.dsh');
    // Per-provider persistent profile: Chrome keeps its historical directory, Edge gets its own.
    // Sharing one headed profile across vendors would mix state and hide identity problems.
    const suffix = this.provider === 'chrome' ? '' : `-${this.provider}`;
    return join(home, 'ui-testing', `headed-profile${suffix}`);
  }

  /**
   * Ensure the browser process/CDP is up. Mutually exclusive with close(): a caller that arrives
   * while the host is closing waits for it and then starts a fresh generation.
   */
  async ensureBrowser(signal) {
    for (;;) {
      if (this.closing) { try { await this.closing; } catch { /* closed */ } continue; }
      if (this.starting) return abortable(this.starting, signal);
      if (this.browserCdp && !this.browserCdp.closed) return this.browserCdp;
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
        const created = await browserCdp.send('Target.createTarget', {
          url: 'about:blank', ...(this.backgroundHeaded ? { background: true } : {}),
        }, { timeoutMs: PAGE_CREATE_TIMEOUT_MS });
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
      // A new target can create a native window after browser startup.
      await this.#hideHeadedWindows(this.proc);
      if (this.closing || this.browserCdp !== browserCdp || this.generation !== generation) {
        cdp.close();
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
    // Popup admission tickets and windowOpen intents belong to this browser generation: a ticket
    // minted before close must never be redeemable after the next start.
    this.popupTickets.clear();
    this.windowIntents.clear();
    this.popupInFlight.clear();
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
      terminateProcessTree(proc);
      const exited = await waitForExit(proc, 1200);
      if (!exited) {
        terminateProcessTree(proc, { force: true });
        await waitForExit(proc, 500);
      }
    }
    if (dir && !this.profilePersistent) await this.#removeProfileDir(dir);
    this.profilePersistent = false;
    this.windowHidden = false;
  }

  async #spawn(signal) {
    // Resolve first: a missing browser must fail before a profile directory is created. The
    // resolution is per provider — an Edge host must never launch a Chrome binary (§8).
    const resolution = resolveProviderExecutable({ provider: this.provider });
    this.executablePath = resolution.path;
    if (!resolution.path) {
      throw new BrowserError(
        'DEPENDENCY_MISSING',
        `${this.provider} 可执行文件不可用（${resolution.reason}）：已尝试 ${resolution.candidates.slice(0, 4).join(', ')}`,
        { provider: this.provider, reason: resolution.reason, candidates: resolution.candidates.slice(0, 8) },
      );
    }
    const chromeBin = resolution.path;
    const generation = this.generation + 1;
    this.generation = generation;
    const overallDeadline = Date.now() + DEVTOOLS_STARTUP.totalBudgetMs;
    let attempts = 0;
    let lastError;
    for (let round = 1; round <= DEVTOOLS_STARTUP.maxAttempts; round += 1) {
      checkAbort(signal);
      this.#assertSpawnGeneration(generation);
      if (Date.now() >= overallDeadline) break;
      attempts = round;
      let profileDir;
      let proc;
      let browserCdp;
      let stderr;
      try {
        const candidate = await this.#pickDevtoolsPort(Math.min(overallDeadline, Date.now() + DEVTOOLS_STARTUP.attemptTimeoutMs));
        if (!candidate) throw devtoolsStartupError('port-unavailable', attempts);
        const attemptDeadline = Math.min(overallDeadline, Date.now() + DEVTOOLS_STARTUP.attemptTimeoutMs);
        if (attemptDeadline <= Date.now()) throw devtoolsStartupError('port-unavailable', attempts);
        // Headed reuses one persistent profile (login/CF clearance); headless keeps the fresh
        // disposable profile per attempt so a half-written profile cannot poison a retry.
        if (this.displayMode === 'headed') {
          profileDir = this.headedProfileDir();
          mkdirSync(profileDir, { recursive: true });
          this.profilePersistent = true;
        } else {
          profileDir = await mkdtemp(join(tmpdir(), 'dsh-ui-testing-'));
          this.profilePersistent = false;
        }
        this.profileDir = profileDir;
        proc = this.#spawnChrome(chromeBin, profileDir, candidate.port);
        this.proc = proc;
        stderr = this.#watchChromeStderr(proc);
        proc.on('exit', () => {
          // A late exit event from an old attempt must never clear the new attempt's state.
          if (this.proc !== proc || this.generation !== generation) return;
          this.proc = undefined;
          this.browserCdp = undefined;
          this.port = 0;
          this.windowHidden = false;
        });
        const ready = await this.#awaitDevtoolsReady({
          chromeBin, proc, stderr, port: candidate.port, deadline: attemptDeadline, signal, generation,
        });
        browserCdp = new Cdp(ready.wsUrl);
        try {
          await browserCdp.connect({ signal });
        } catch (error) {
          const classified = asBrowserError(error);
          const code = classified.code === 'CDP_TIMEOUT' ? 'CDP_TIMEOUT' : 'CDP_DISCONNECTED';
          throw new BrowserError(code, '调试端点已就绪但 CDP 连接失败：' + classified.message, { phase: 'connect', attempts });
        }
        this.#assertSpawnGeneration(generation);
        this.browserCdp = browserCdp;
        // Internal only: the public DevTools URL is built from uiState and needs a live page too.
        this.port = candidate.port;
        this.#assertSpawnGeneration(generation);
        browserCdp.on((message) => {
          if (this.browserCdp !== browserCdp) return;
          this.#onBrowserEvent(browserCdp, message);
        });
        // Record the pre-existing about:blank target BEFORE enabling auto-attach: setAutoAttach
        // also attaches to existing targets, and an attach event for the initial page must never
        // be classified as a popup (that would block/close the page we are about to reuse).
        // §8: "CDP connected" is not proof of the product. Verify the vendor after the transport
        // is up and before any page work; a mismatch is reported, never silently accepted.
        {
          // Every provider is checked; whether *missing* evidence rejects is per vendor
          // (`WEB_PROVIDER_VENDOR.failClosedOnMissing`): edge fails closed, chrome stays lenient.
          let version = null;
          try {
            version = await browserCdp.send('Browser.getVersion', {}, { signal });
          } catch {
            version = null; // no evidence; the vendor rule decides whether that is fatal
          }
          const identity = verifyProviderProduct({ provider: this.provider, version });
          this.product = identity.product;
          this.productVerified = identity.verified === true;
          if (!identity.ok) {
            throw new BrowserError(
              'DEPENDENCY_MISSING',
              identity.reason === WEB_PROVIDER_REASONS.IDENTITY_UNVERIFIED
                ? `启动的产品身份无法确认（provider=${this.provider}）：拿不到 Browser.getVersion`
                : `启动的产品身份与 provider 不符：期望 ${String(identity.expected)}，实际 ${String(identity.product)}`,
              {
                provider: this.provider,
                product: identity.product,
                expected: identity.expected,
                reason: identity.reason,
                path: resolution.path,
              },
            );
          }
        }
        this.initialTargetId = await this.#findInitialPage(signal);
        if (this.backgroundHeaded && !this.initialTargetId) {
          const initial = await browserCdp.send('Target.createTarget', {
            url: 'about:blank', newWindow: true, background: true,
          }, { signal, timeoutMs: PAGE_CREATE_TIMEOUT_MS });
          this.initialTargetId = initial.targetId;
        }
        await this.#hideHeadedWindows(proc);
        this.#assertSpawnGeneration(generation);
        await browserCdp.send('Target.setAutoAttach', {
          autoAttach: true, waitForDebuggerOnStart: true, flatten: true,
          filter: [{ type: 'page', exclude: false }],
        }, { signal });
        this.log(`chromium ready on devtools port ${candidate.port} (generation ${generation})`);
        return browserCdp;
      } catch (error) {
        const classified = asBrowserError(error);
        const cleanupFailed = await this.#disposeAttempt({ proc, profileDir, browserCdp, persistent: this.profilePersistent });
        if (this.proc === proc) this.proc = undefined;
        if (this.profileDir === profileDir) this.profileDir = undefined;
        if (this.browserCdp === browserCdp) this.browserCdp = undefined;
        this.port = 0;
        this.initialTargetId = undefined;
        if (classified.code === 'ABORTED' || this.closing || this.generation !== generation) throw classified;
        if (cleanupFailed) {
          throw new BrowserError('CDP_DISCONNECTED', 'Chromium 启动失败且本轮进程未确认退出', {
            phase: 'startup', reason: 'cleanup-failed', attempts,
          });
        }
        const reason = classified.details && classified.details.reason;
        if (classified.code === 'UNSUPPORTED' || !DEVTOOLS_RETRYABLE.has(reason)) throw classified;
        lastError = classified;
      }
    }
    throw lastError || devtoolsStartupError('debugger-not-ready', attempts || 1);
  }

  /** Fail a start attempt immediately when the host closed or a newer generation took over. */
  #assertSpawnGeneration(generation) {
    if (this.closing || this.generation !== generation) {
      throw new BrowserError('CDP_DISCONNECTED', '浏览器在启动过程中被关闭', {
        phase: 'startup', generation, currentGeneration: this.generation, closing: Boolean(this.closing),
      });
    }
  }

  /** One Chrome process with the exact loopback port + matching Origin allow-list. */
  #spawnChrome(chromeBin, profileDir, port) {
    const args = [
      ...(this.displayMode === 'headed' ? [] : ['--headless=new']),
      '--remote-debugging-address=127.0.0.1',
      `--remote-debugging-port=${port}`,
      // Chrome 111+ rejects a CDP WebSocket whose Origin is not allow-listed (even same-origin
      // DevTools). The wildcard `*` is forbidden: it would admit any website's Origin.
      `--remote-allow-origins=http://127.0.0.1:${port}`,
      `--user-data-dir=${profileDir}`,
      '--no-first-run',
      '--no-default-browser-check',
      '--disable-gpu',
      '--hide-scrollbars',
      // Page output stays off the host speakers (the panel is the listener). The tap in
      // targets/web/audio-tap.js reads the page's audio graph, which keeps running regardless.
      '--mute-audio',
      // The tap's private AudioContext has no user gesture in an automated page; without this the
      // context stays suspended and the preview is silent.
      '--autoplay-policy=no-user-gesture-required',
      '--disable-background-timer-throttling',
      '--disable-renderer-backgrounding',
      // Keep hidden/occluded page targets compositing: without this, a non-front page stops
      // emitting screencast frames, so only one workspace preview would ever update.
      '--disable-backgrounding-occluded-windows',
      '--disable-features=CalculateNativeWinOcclusion',
      '--window-size=1280,800',
      ...(this.displayMode === 'headed'
        ? (process.env.DSH_UI_TESTING_HEADED_VISIBLE === '1'
          ? ['--start-maximized']
          : ['--window-position=-10000,-10000'])
        : []),
      this.backgroundHeaded ? '--no-startup-window' : 'about:blank',
    ];
    return spawn(chromeBin, args, { stdio: ['ignore', 'ignore', 'pipe'] });
  }

  /**
   * Bounded stderr line buffer: the identity line and bind failures are all this start needs.
   * The complete debugger URL is never logged and never accumulates beyond one buffer.
   */
  #watchChromeStderr(proc) {
    const state = { spawnError: undefined, exited: false, exitCode: null, signal: null, identity: null, bindFailed: false };
    let buffer = '';
    proc.on('error', (error) => { state.spawnError = error; });
    proc.on('exit', (code, signal) => { state.exited = true; state.exitCode = code; state.signal = signal; });
    proc.stderr.setEncoding('utf8');
    proc.stderr.on('data', (chunk) => {
      buffer += String(chunk);
      if (buffer.length > DEVTOOLS_STARTUP.stderrBufferBytes) buffer = buffer.slice(-DEVTOOLS_STARTUP.stderrBufferBytes);
      let index;
      while ((index = buffer.indexOf('\n')) >= 0) {
        const line = buffer.slice(0, index);
        buffer = buffer.slice(index + 1);
        const listening = /DevTools listening on (ws:\/\/\S+)/.exec(line);
        if (listening) {
          try {
            const endpoint = parseDevtoolsBrowserEndpoint(listening[1], Number(new URL(listening[1]).port));
            if (endpoint) state.identity = endpoint;
          } catch { /* not an identity line */ }
          continue;
        }
        if (/failed to bind|address already in use|cannot start http server for devtools/i.test(line)) {
          state.bindFailed = true;
          continue;
        }
        if (/error|fatal/i.test(line)) this.log('chrome: ' + line.trim().slice(0, 300));
      }
    });
    return state;
  }

  /**
   * Wait for `/json/version` on the candidate IPv4 loopback port AND prove this process owns it.
   * An endpoint that answers but cannot be tied to this child's stderr identity is never adopted:
   * a port race must fail closed instead of attaching to a stranger's Chrome.
   */
  async #awaitDevtoolsReady({ chromeBin, proc, stderr, port, deadline, signal, generation }) {
    let lastReason = 'debugger-not-ready';
    while (Date.now() < deadline) {
      checkAbort(signal);
      this.#assertSpawnGeneration(generation);
      if (stderr.spawnError) {
        const code = stderr.spawnError.code;
        if (code === 'ENOENT' || code === 'EACCES') {
          throw new BrowserError('UNSUPPORTED', `Chrome 可执行文件无法启动（${code}）：${chromeBin}`, { binary: chromeBin, phase: 'spawn' });
        }
        throw new BrowserError('CDP_DISCONNECTED', 'Chromium 启动失败', { phase: 'spawn', reason: 'spawn-failed' });
      }
      // An explicit bind failure is a port conflict even when the child then exits: retry with a
      // new candidate instead of misclassifying it as a non-port startup crash.
      if (stderr.bindFailed) throw devtoolsStartupError('port-unavailable', 0);
      if (stderr.exited || proc.exitCode !== null) {
        throw new BrowserError('CDP_DISCONNECTED', 'Chromium 启动进程提前退出', {
          phase: 'spawn', reason: 'process-exited',
          ...(Number.isInteger(stderr.exitCode) ? { exitCode: stderr.exitCode } : {}),
          ...(stderr.signal ? { signal: stderr.signal } : {}),
        });
      }
      if (stderr.identity && stderr.identity.port !== port) lastReason = 'endpoint-mismatch';
      const version = await this.#fetchJsonVersion(port, deadline - Date.now(), signal);
      if (version) {
        const endpoint = parseDevtoolsBrowserEndpoint(version.webSocketDebuggerUrl, port);
        if (!endpoint) throw devtoolsStartupError('endpoint-mismatch', 0);
        const listener = await inspectLoopbackListener(port);
        if (listener === 'external') throw devtoolsStartupError('port-unavailable', 0);
        if (!stderr.identity) {
          // Reachable but unproven: keep polling for this child's identity line, never adopt it.
          lastReason = 'debugger-not-ready';
        } else if (stderr.identity.browserId !== endpoint.browserId || stderr.identity.port !== port) {
          throw devtoolsStartupError('endpoint-mismatch', 0);
        } else {
          // Normalise to IPv4: the contract publishes/uses only 127.0.0.1 even if Chrome's own
          // stderr printed a localhost/[::1] form.
          return { wsUrl: `ws://127.0.0.1:${port}${endpoint.pathname}` };
        }
      }
      const wait = Math.min(DEVTOOLS_STARTUP.pollIntervalMs, deadline - Date.now());
      if (wait > 0) await delay(wait);
    }
    throw devtoolsStartupError(lastReason, 0);
  }

  /** Bounded `/json/version` GET; failures are just "not ready yet" (never a CDP command). */
  async #fetchJsonVersion(port, remainingMs, signal) {
    const budget = Math.max(1, Math.min(DEVTOOLS_STARTUP.fetchTimeoutMs, remainingMs));
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), budget);
    timer.unref?.();
    const combined = signal && typeof AbortSignal.any === 'function'
      ? AbortSignal.any([controller.signal, signal]) : controller.signal;
    try {
      const response = await fetch(`http://127.0.0.1:${port}/json/version`, {
        signal: combined, redirect: 'error', headers: { accept: 'application/json' },
      });
      if (!response.ok) return null;
      const text = await response.text();
      if (text.length > 65536) return null;
      const parsed = JSON.parse(text);
      return parsed && typeof parsed === 'object' ? parsed : null;
    } catch (error) {
      if (signal?.aborted) throw new BrowserError('ABORTED', '操作已取消');
      return null;
    } finally {
      clearTimeout(timer);
    }
  }

  /** Bounded candidate picking: at most a handful of probes, all inside the attempt budget. */
  async #pickDevtoolsPort(deadline) {
    for (let index = 0; index < DEVTOOLS_STARTUP.portCandidates; index += 1) {
      if (Date.now() >= deadline) return null;
      const candidate = await probeLoopbackDevtoolsPort();
      if (candidate.port) {
        if (!candidate.ipv6 && !this.ipv6ProbeLogged) {
          this.ipv6ProbeLogged = true;
          this.log('devtools port probe: ::1 unavailable, using 127.0.0.1 only');
        }
        return candidate;
      }
      await delay(20);
    }
    return null;
  }

  /** Tear down exactly one failed attempt; returns true when the process could not be confirmed gone. */
  async #disposeAttempt({ proc, profileDir, browserCdp, persistent = false }) {
    try { browserCdp?.close(); } catch { /* ignore */ }
    let cleanupFailed = false;
    if (proc && proc.exitCode === null) {
      terminateProcessTree(proc);
      const exited = await waitForExit(proc, DEVTOOLS_STARTUP.killGraceMs);
      if (!exited) {
        terminateProcessTree(proc, { force: true });
        const killed = await waitForExit(proc, DEVTOOLS_STARTUP.killFinalMs);
        if (!killed) {
          cleanupFailed = true;
          this.log('[BROWSER_CLEANUP_FAILED] 启动尝试的 Chromium 进程未确认退出');
        }
      }
    }
    if (profileDir && !persistent) await this.#removeProfileDir(profileDir);
    return cleanupFailed;
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
    if (message.method === 'Target.targetDestroyed') {
      const owned = this.ownedTargets.get(message.params.targetId);
      if (owned && owned.runtime && owned.runtime.kind === 'popup') {
        // window.close / target crash: close once; registry removes the view entry.
        const runtime = owned.runtime;
        setImmediate(() => { runtime.close().catch(() => {}); });
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
    const owned = this.ownedTargets.get(targetId);
    if (owned) {
      // A popup adopt already owns this paused session: its bootstrap resume happens after the
      // Fetch guard is ready. Never resume it here.
      if (!owned.initializing) this.#resumeAndDetach(browserCdp, targetId, sessionId);
      return;
    }
    if (targetId === this.initialTargetId) {
      this.#resumeAndDetach(browserCdp, targetId, sessionId);
      return;
    }
    if (this.pendingCreates > 0) {
      // Might be the target of our own in-flight createTarget: park it paused; the owning create
      // adopts it, or the last create settles it as a popup. Never resume an unknown target.
      this.pendingAttach.set(targetId, sessionId);
      return;
    }
    if (this.popupInFlight.has(targetId)) return;
    void this.#tryAdoptPopup(browserCdp, targetId, sessionId, targetInfo);
  }

  /** Authenticated GUI input gives one short-lived popup ticket (one action → one target). */
  noteGuiInput(runtime, events) {
    if (!runtime || !Array.isArray(events)) return;
    const meaningful = events.some((event) => {
      const kind = String(event && event.kind || '');
      const type = String(event && (event.type || event.eventType) || '');
      return (kind === 'mouse' && type === 'mousePressed')
        || (kind === 'key' && (type === 'keyDown' || type === 'rawKeyDown'))
        || kind === 'text';
    });
    if (!meaningful) return;
    this.popupTickets.set(runtime.runtimeId, { at: Date.now(), consumed: false });
  }

  /** Page.windowOpen intent, matched to the raw target's openerId (not script-accessible opener). */
  noteWindowOpen(runtime, params = {}) {
    if (!runtime) return;
    const at = Date.now();
    this.windowIntents.set(runtime.runtimeId, {
      at,
      url: String(params.url || ''),
      windowName: String(params.windowName || ''),
      userGesture: params.userGesture === true,
      openEventId: 'popup-' + (++this.popupEventSeq),
      consumed: false,
    });
  }

  #popupUrl(targetInfo, intent) {
    const targetUrl = String(targetInfo && targetInfo.url || '');
    const intentUrl = String(intent && intent.url || '');
    const blank = (value) => !value || /^(about:blank|data:|blob:|javascript:)/i.test(value);
    const chosen = !blank(targetUrl) ? targetUrl : (!blank(intentUrl) ? intentUrl : '');
    if (!chosen) return null;
    let target;
    let intended;
    try { target = new URL(chosen); } catch { return null; }
    if (!/^https?:$/.test(target.protocol)) return null;
    if (!blank(targetUrl) && !blank(intentUrl)) {
      try { intended = new URL(intentUrl); } catch { return null; }
      if (intended.href !== target.href) return null;
    }
    return target.href;
  }

  async #tryAdoptPopup(browserCdp, targetId, sessionId, targetInfo) {
    if (this.popupInFlight.has(targetId)) return;
    this.popupInFlight.add(targetId);
    let parent;
    let parentEntry;
    let child;
    let entry;
    let release = () => {};
    let ownedSet = false;
    let reason = 'initialize-failed';
    let openEventId = null;
    try {
      const openerId = targetInfo && targetInfo.openerId;
      const opener = openerId ? this.ownedTargets.get(openerId) : undefined;
      parent = opener && opener.runtime;
      parentEntry = parent && parent.registry && parent.registry.findByRuntimeId(parent.runtimeId);
      if (!parent || !parentEntry) {
        reason = 'no-opener';
        this.#blockPopup(browserCdp, targetId, sessionId, { reason });
        return;
      }
      // Agent input/eval can also set userGesture:true; never adopt while the parent is leased or
      // actively agent-driven (docs/popup §3.1/§5).
      if (parent.hasLease() || Date.now() < parent.agentUntil) {
        reason = 'busy';
        this.#blockPopup(browserCdp, targetId, sessionId, { parentEntry, reason, openEventId });
        return;
      }
      const deadline = Date.now() + 1000;
      let ticket;
      let intent;
      while (Date.now() < deadline) {
        ticket = this.popupTickets.get(parent.runtimeId);
        intent = this.windowIntents.get(parent.runtimeId);
        if (ticket && !ticket.consumed && intent && !intent.consumed && intent.userGesture) break;
        await new Promise((resolve) => setTimeout(resolve, 50));
      }
      if (!ticket || ticket.consumed || Date.now() - ticket.at > 4000 || Date.now() >= parent.humanUntil) {
        reason = 'no-human-input';
        this.#blockPopup(browserCdp, targetId, sessionId, { parentEntry, reason, openEventId });
        return;
      }
      if (!intent || intent.consumed || !intent.userGesture || Date.now() - intent.at > 1500) {
        reason = intent && intent.userGesture ? 'source-stale' : 'automatic-popup';
        this.#blockPopup(browserCdp, targetId, sessionId, { parentEntry, reason, openEventId });
        return;
      }
      openEventId = intent.openEventId || null;
      const url = this.#popupUrl(targetInfo, intent);
      // Policy A (2026-11-06): a human-click popup that opens a scripting/blank window and then
      // navigates is common (Baidu News et al.). Adopt it only when BOTH the raw target and the
      // declared intent are blank/scripting; the first document must still become an allowed
      // HTTP(S) page within a bounded settle window, otherwise it is blocked as before.
      let blankFirst = false;
      if (url) {
        try { await validateTarget(url, { origins: [...parent.origins] }); }
        catch {
          reason = 'target-forbidden';
          this.#blockPopup(browserCdp, targetId, sessionId, { parentEntry, reason, openEventId });
          return;
        }
      } else if (isBlankPageUrl(targetInfo && targetInfo.url) && isBlankPageUrl(intent && intent.url)) {
        blankFirst = true;
      } else {
        reason = 'target-forbidden';
        this.#blockPopup(browserCdp, targetId, sessionId, { parentEntry, reason, openEventId });
        return;
      }
      ticket.consumed = true;
      intent.consumed = true;
      try { release = parent.registry.reservePopupSlot(parentEntry); }
      catch (limitError) {
        reason = limitError && limitError.code === 'TAB_LIMIT' ? 'popup-limit' : 'busy';
        this.#blockPopup(browserCdp, targetId, sessionId, { parentEntry, reason, openEventId });
        return;
      }
      const viewId = randomUUID().replace(/-/gu, '').slice(0, 20);
      child = new Runtime(this.log, {
        host: this, origins: parent.origins, scope: parent.scope, registry: parent.registry,
        kind: 'popup', parentRuntimeId: parent.runtimeId, viewId, parentKey: parentEntry.key,
        openEventId, sourcePanelId: null, createdBy: 'gui', inheritView: parent.view,
      });
      entry = parent.registry.addPopupEntry({
        parentEntry, runtime: child, viewId, openEventId, sourcePanelId: null,
      });
      const generation = this.generation;
      this.ownedTargets.set(targetId, { runtime: child, generation, initializing: true });
      ownedSet = true;
      const wsUrl = await this.#resolveTargetWsUrl(browserCdp, targetId, AbortSignal.timeout(6000));
      const cdp = new Cdp(wsUrl);
      await cdp.connect({ signal: AbortSignal.timeout(6000) });
      if (this.backgroundHeaded) await this.#hideHeadedWindows(this.proc);
      const resume = async () => {
        await browserCdp.send('Runtime.runIfWaitingForDebugger', {}, { sessionId, timeoutMs: 5000 });
        await browserCdp.send('Target.detachFromTarget', { sessionId }, { timeoutMs: 5000 });
      };
      await child.adoptPage({ targetId, cdp, generation }, { signal: AbortSignal.timeout(10000), resume });
      // The intent URL is not success: v1 only accepts a real HTTP(S) first document (no
      // about:blank/data/blob scripting page). Give the first navigation a bounded settle window;
      // a blank-first window gets a longer one because its navigation starts only after resume.
      const settleMs = blankFirst ? 4000 : 1000;
      const settleDeadline = Date.now() + settleMs;
      while (Date.now() < settleDeadline && !/^https?:/i.test(String(child.url || ''))) {
        await new Promise((resolve) => setTimeout(resolve, 50));
      }
      const firstDocument = String(child.url || '');
      if (!/^https?:/i.test(firstDocument)) {
        reason = 'target-forbidden';
        throw new BrowserError('POPUP_UNSUPPORTED', 'popup 的首个文档不是可居留的 HTTP(S) 页面');
      }
      // Validate the document the child actually landed on (not only the declared intent): a
      // blank-first window may redirect anywhere after resume.
      try { await validateTarget(firstDocument, { origins: [...parent.origins] }); }
      catch {
        reason = 'target-forbidden';
        throw new BrowserError('POPUP_UNSUPPORTED', 'popup 的首个文档不在允许范围');
      }
      await this.#hideHeadedWindows(this.proc);
      if (this.closing || this.browserCdp !== browserCdp || this.generation !== generation) {
        throw new BrowserError('CDP_DISCONNECTED', '浏览器在接管弹窗时被关闭');
      }
      const owned = this.ownedTargets.get(targetId);
      if (owned) owned.initializing = false;
      entry.status = 'ready';
      if (this.backgroundHeaded) child.activate().catch(() => false);
      parent.registry.bumpViews(entry.primaryKey);
      this.log('adopted popup target ' + targetId + ' as view ' + viewId + ' (parent ' + parent.runtimeId + ')');
    } catch (error) {
      this.log('popup adopt failed: ' + String((error && error.message) || error));
      try { if (child) await child.close(); } catch { /* ignore */ }
      if (ownedSet) {
        try { await this.#closeOwnedTarget(targetId); } catch { /* ignore */ }
      } else {
        this.#blockPopup(browserCdp, targetId, sessionId, { parentEntry, reason, openEventId });
      }
      if (ownedSet && parentEntry) {
        try { parentEntry.runtime.registry?.addPopupNotice(parentEntry, { reason, openEventId }); } catch { /* ignore */ }
      }
    } finally {
      release();
      this.popupInFlight.delete(targetId);
      try { if (parent) this.popupTickets.delete(parent.runtimeId); this.windowIntents.delete(parent && parent.runtimeId); } catch { /* ignore */ }
    }
  }

  #resumeAndDetach(browserCdp, targetId, sessionId) {
    this.pendingAttach.delete(targetId);
    browserCdp.send('Runtime.runIfWaitingForDebugger', {}, { sessionId })
      .then(() => browserCdp.send('Target.detachFromTarget', { sessionId }))
      .catch(() => {});
  }

  /** Install fail-all interception BEFORE resuming, then close the extra page target. */
  #blockPopup(browserCdp, targetId, sessionId, options = {}) {
    this.log('blocking popup target ' + targetId + (options.reason ? ' reason=' + options.reason : ''));
    this.pendingAttach.delete(targetId);
    if (options.parentEntry && options.reason) {
      try { options.parentEntry.runtime.registry?.addPopupNotice(options.parentEntry, {
        reason: options.reason, openEventId: options.openEventId || null,
      }); } catch { /* projection only */ }
    }
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

export const T2_LIMITS = Object.freeze({
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

export const T2_MOUSE_BUTTONS = Object.freeze({ left: 1, right: 2, middle: 4 });
/**
 * Fixed recovery hint for a scroll target that cannot be driven right now (contract §4.3).
 *
 * `browser_scroll` deliberately does NOT scroll the target (or its ancestors) into view — that is
 * the click/type preparation semantics, not a scroll tool's. The caller scrolls the document with a
 * target-less call and retries. The text is a constant so it never leaks a selector literal.
 */

export const T2_SCROLL_VIEWPORT_HINT = '先用不带 ref/selector 的 browser_scroll 滚动文档，使目标进入视口后重试';

export const T2_FORM_KINDS = Object.freeze(['textbox', 'checkbox', 'radio', 'combobox', 'slider']);

export const T2_WAIT_STATE_KEYS = Object.freeze(['visible', 'enabled', 'checked', 'valueEquals']);
/**
 * AX roles that get a ref in the snapshot. Only nodes with a main-document `backendDOMNodeId` are
 * eligible; StaticText/inline text and virtual AX nodes never are (contract §3.1).
 */

export const T2_REF_ROLES = new Set([
  'button', 'link', 'textbox', 'searchbox', 'checkbox', 'radio', 'combobox', 'listbox', 'option',
  'slider', 'spinbutton', 'switch', 'tab', 'treeitem', 'gridcell', 'menuitem', 'menuitemcheckbox',
  'menuitemradio', 'togglebutton', 'disclosuretriangle', 'scrollbar', 'textfield',
]);
/** Generic-ish AX containers: dropped when empty, collapsed when they have exactly one child. */

/** Generic-ish AX containers: dropped when empty, collapsed when they have exactly one child. */
export const T2_CONTAINER_ROLES = new Set(['generic', 'none', 'GenericContainer', 'Section', 'group', 'paragraph']);

/** Collapse whitespace (incl. NBSP / zero-width) — snapshot text never carries layout whitespace. */

/** Collapse whitespace (incl. NBSP / zero-width) — snapshot text never carries layout whitespace. */
export function t2Flatten(value) {
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

export function t2CollapseWhitespace(value) {
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

export function t2IsTextTransparent(node) {
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

export function t2BuildTextProjection(roots, childrenOf) {
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

export function t2FormatTextLeaf(rawText) {
  return t2TruncateBytes(redactText(t2CollapseWhitespace(rawText)), T2_LIMITS.textBytes);
}

/** Truncate on a Unicode boundary with a `…` terminator; the limit includes the terminator. */

/** Truncate on a Unicode boundary with a `…` terminator; the limit includes the terminator. */
export function t2TruncateBytes(value, maxBytes) {
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

/** Public string projection: URL/secret redaction first, then the byte bound (contract §5.1). */
export function t2Public(value, maxBytes) {
  return t2TruncateBytes(t2Flatten(redactText(t2Flatten(value))), maxBytes);
}

export function t2InvalidArgument(message, details = {}) {
  return new BrowserError('INVALID_ARGUMENT', message, details);
}

export function t2Object(value, name) {
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw t2InvalidArgument(`${name} 必须是普通对象`);
  return value;
}

export function t2RejectUnknown(value, allowed, name) {
  for (const key of Object.keys(value)) {
    if (!allowed.includes(key)) throw t2InvalidArgument(`${name} 不接受字段：${key}`);
  }
}

export function t2StringField(value, { name, maxBytes, allowEmpty = false, nullable = false }) {
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

export function t2BooleanField(value, fallback, name) {
  if (value === undefined || value === null) {
    if (fallback === undefined) throw t2InvalidArgument(`${name} 必填`);
    return fallback;
  }
  if (typeof value !== 'boolean') throw t2InvalidArgument(`${name} 必须是布尔值`);
  return value;
}

export function t2IntegerField(value, fallback, min, max, name) {
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

export function t2NumberField(value, fallback, min, max, name) {
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

export function t2ModifierList(value) {
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

export function t2RefOrSelector(options, { name = '', exactlyOne = true, allowNone = false } = {}) {
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

/** Evidence projection of a target: a selector literal is never exposed (contract §5.2). */
export function t2Requested(target) {
  if (!target) return { kind: 'document' };
  if (target.kind === 'ref') return { kind: 'ref', ref: target.ref };
  return { kind: 'selector' };
}

export function t2AxValue(property) {
  if (!property || property.value === undefined) return null;
  const raw = property.value;
  if (raw && typeof raw === 'object' && 'value' in raw) return raw.value;
  return raw;
}

export function t2AxProps(node) {
  const map = new Map();
  for (const property of Array.isArray(node.properties) ? node.properties : []) {
    if (property && typeof property.name === 'string') map.set(property.name, t2AxValue(property));
  }
  return map;
}

/** `Properties`-driven states in the contract's fixed token order. */

/** `Properties`-driven states in the contract's fixed token order. */
export function t2StateTokens(props) {
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

export function t2FormatAxNode(node, { frameId = null, textOverride = undefined } = {}) {
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

export function t2RoleIsContainer(role) {
  return T2_CONTAINER_ROLES.has(role);
}

/** Raw (pre-truncation, pre-redaction) AX accessors — redundancy checks must use these. */

/** Raw (pre-truncation, pre-redaction) AX accessors — redundancy checks must use these. */
export function t2AxRoleOf(node) {
  return node && node.role && typeof node.role.value === 'string' && node.role.value ? node.role.value : 'generic';
}

export function t2AxRawName(node) {
  return node && node.name && node.name.value !== undefined && node.name.value !== null ? String(node.name.value) : '';
}

export function t2AxRawText(node) {
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

export function t2NameFromContents(node) {
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

export const T2_AX_TEXT_ROLES = new Set(['StaticText', 'InlineTextBox', 'LabelText', 'text']);
/**
 * Roles whose children are structural and must never be swallowed by the redundancy rule, even when
 * the concatenated child text happens to equal the owner's name (contract §3.1.1).
 */

export const T2_KEEP_CHILDREN_ROLES = new Set([
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

export function t2TextChain(children, childrenOf) {
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

export function t2IsRedundantTextSubtree(node, children, childrenOf) {
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

export const T2_NODE_INFO_FN = `function (options) {
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

/**
 * One-shot delivery probe for synthetic input (docs/web/input-delivery.md).
 *
 * A CDP `Input.*` dispatch returning is **not** evidence that the page saw anything: the event can
 * land in a renderer whose document was replaced, or in a page this runtime no longer owns. The
 * probe installs capture listeners inside the page *before* the dispatch and reports what the page
 * actually observed afterwards, so "dispatched" can never be mistaken for "delivered".
 *
 * Kept as source strings (no bundler, no page globals leaking into the app's namespace): the marker
 * is deleted by the read step, and a 5 s timer removes the listeners even if the read never comes.
 */
export const INPUT_PROBE_INSTALL_FN = `(function () {
  var KEY = '__utb_input_probe__';
  try {
    var previous = window[KEY];
    if (previous && typeof previous.cleanup === 'function') previous.cleanup();
  } catch (error) { /* a broken previous probe must not block this one */ }
  var types = ['pointerdown', 'mousedown', 'pointerup', 'mouseup', 'click', 'keydown', 'keyup', 'input', 'wheel', 'mousemove', 'pointermove'];
  var state = { seen: [], started: Date.now() };
  var record = function (event) { if (event.isTrusted && !state.seen.includes(event.type)) state.seen.push(event.type); };
  for (var index = 0; index < types.length; index += 1) document.addEventListener(types[index], record, true);
  var cleanup = function () {
    for (var i = 0; i < types.length; i += 1) document.removeEventListener(types[i], record, true);
  };
  state.cleanup = function () {
    clearTimeout(timer);
    cleanup();
    if (window[KEY] === state) delete window[KEY];
  };
  var timer = setTimeout(state.cleanup, 5000);
  window[KEY] = state;
  return { installed: window[KEY] === state };
})()`;

/** Snapshot the probe. Only the final read removes the marker and its listeners. */
export const INPUT_PROBE_READ_FN = `(function (remove) {
  var KEY = '__utb_input_probe__';
  var state = window[KEY];
  if (!state) return { present: false, seen: [] };
  var seen = state.seen.slice();
  if (remove) state.cleanup();
  return { present: true, seen: seen };
})`;

/** The two halves a click gesture cannot happen without (a handler may suppress `click` itself). */
export const INPUT_DELIVERY_CLICK_GROUPS = Object.freeze([
  Object.freeze(['mousedown', 'pointerdown']),
  Object.freeze(['mouseup', 'pointerup']),
]);

/**
 * Decide whether a dispatched gesture was actually delivered, from what the page recorded.
 *
 * `groups` lists what the page must have observed: each group is a set of alternative event types
 * and **every** group must be satisfied. A synthetic click the page never saw produces nothing, so
 * requiring press *and* release keeps the check honest without depending on `click` (which a
 * handler may legitimately have suppressed via `preventDefault`).
 */
export function inputDeliveryVerdict(seen, groups = INPUT_DELIVERY_CLICK_GROUPS) {
  const events = Array.isArray(seen) ? seen : [];
  const required = Array.isArray(groups) && groups.length ? groups : INPUT_DELIVERY_CLICK_GROUPS;
  const matched = required.map((group) => events.some((type) => group.includes(type)));
  return {
    delivered: matched.every(Boolean),
    missing: required.filter((group, index) => !matched[index]).map((group) => group.join('|')),
    seen: events.slice(0, 12),
  };
}

/** The real (deep-shadow) activeElement, as a remote object so CDP can describe it. */
export const T2_DEEP_FOCUS_FN = `(function () {
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

/** Two consecutive animation frames within 100ms: bbox must not move more than 1 CSS px. */
export const T2_STABILITY_FN = `function () {
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

/** Put the caret at the end of the current value (`replace:false` appends, never a random caret). */
export const T2_CARET_END_FN = `function () {
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

/** Page-level observation: address/title/scroll/viewport plus whether a real element is focused. */
export const T2_PAGE_STATE_FN = `(function () {
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

/** Read the target's (or the document's) scroll offsets for scroll evidence/stability. */
export const T2_SCROLL_READ_FN = `function () {
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

/** Scroll container for a document-level scroll: `document.scrollingElement`. */
export const T2_DOCUMENT_SCROLLER_FN = `(function () { return document.scrollingElement || document.documentElement; })()`;

/** Read an input's current value for in-memory verification only (never published). */

/** Read an input's current value for in-memory verification only (never published). */
export const T2_READ_VALUE_FN = `function () {
  var el = this;
  if (!el || el.nodeType !== 1) return { ok: false, reason: 'not-an-element' };
  var value = '';
  if (String(el.tagName || '').toLowerCase() === 'select') value = String(el.value === null || el.value === undefined ? '' : el.value);
  else if (el.isContentEditable) value = String(el.textContent === null || el.textContent === undefined ? '' : el.textContent);
  else value = String(el.value === null || el.value === undefined ? '' : el.value);
  return { ok: true, value: value, length: value.length };
}`;
/** Native `<select>` write (combobox): option *value* matching, never the native popup. */

/** Native `<select>` write (combobox): option *value* matching, never the native popup. */
export const T2_SELECT_WRITE_FN = `function (payload) {
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

/** Native value write for `input[type=range]` (slider) and for clearing a textbox. */
export const T2_VALUE_WRITE_FN = `function (payload) {
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

/** Read-only option inventory for a native select (pre-check, never mutates). */
export const T2_SELECT_OPTIONS_FN = `function () {
  var el = this;
  if (!el || el.nodeType !== 1) return { ok: false, reason: 'not-an-element' };
  if (String(el.tagName || '').toLowerCase() !== 'select') return { ok: false, reason: 'not-a-select' };
  var options = Array.prototype.map.call(el.options || [], function (option) {
    return { value: String(option.value), disabled: option.disabled === true };
  });
  return { ok: true, multiple: el.multiple === true, options: options };
}`;

/** Range bounds used to validate a slider value before any write (contract §2.2 Field table). */

/** Range bounds used to validate a slider value before any write (contract §2.2 Field table). */
export const T2_RANGE_INFO_FN = `function () {
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

/** Precise scroll for `to:"top"|"bottom"`: explicit value, not a repeated wheel (contract §4.3). */
export const T2_SCROLL_TO_FN = `function (payload) {
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

export const LEGACY_SCOPE = Object.freeze({ key: 'legacy:default', scope: Object.freeze({ id: 'legacy:default', kind: 'legacy', workspaceId: null, degraded: false }) });

export const UNASSIGNED_SCOPE = Object.freeze({ key: 'unassigned:owner', scope: Object.freeze({ id: 'unassigned:owner', kind: 'unassigned', workspaceId: null, degraded: false }) });

export function workspaceScope(workspaceId) {
  return {
    key: `workspace:${workspaceId}`,
    scope: { id: `ws_${sha256Short(workspaceId)}`, kind: 'workspace', workspaceId, degraded: false },
  };
}

export function pathScope(canonicalPath) {
  const hash = sha256Short(canonicalPath, 32);
  return { key: `path:${hash}`, scope: { id: `path:${hash}`, kind: 'path', workspaceId: null, degraded: true } };
}

export function sessionScope(sessionId) {
  const hash = sha256Short(sessionId, 32);
  return { key: `session:${hash}`, scope: { id: `session:${hash}`, kind: 'session', workspaceId: null, degraded: true } };
}

/** One headless browser plus the page being previewed. */

/**
 * Session responses mirror the important session fields at the top level too (`counters`,
 * `state`, `sessionId`, `seq`): the acceptance probes read both `value.session.*` and
 * `value.counters.*`, and a missing alias made a *correct* implementation look broken.
 */

export function sessionAliases(status) {
  const session = status && status.session ? status.session : null;
  return {
    state: session ? session.state : null,
    sessionId: session ? session.id : null,
    seq: session && session.counters ? session.counters.seq : 0,
    counters: session ? session.counters : null,
  };
}

/**
 * TOOL-P1-04 session/status consistency. `activeSessionId`/`bufferedEvents` let a caller tell
 * "no session" apart from "session exists but this page produced nothing":
 *  - `activeSessionId` is the current (running or retained) capture session id, else null;
 *  - `bufferedEvents` is the pre-session candidate buffer (events observed before a session
 *    started); it is never served as session events by `browser_network_events`.
 * A field report of `status.session=null` while events still had rows could not be reproduced from
 * the current store lifecycle (the store clears its event ring together with the session); the root
 * cause is recorded as UNKNOWN rather than claimed fixed. The events wrapper additionally refuses to
 * serve any sessionless event window (docs/network-p0.md §2.2/§3.4).
 */

export function networkStatusAliases(store, status) {
  const session = status && status.session ? status.session : null;
  return {
    activeSessionId: session ? session.id : null,
    attribution: status && status.attribution ? status.attribution : null,
    bufferedEvents: store && Array.isArray(store.preSession) ? store.preSession.length : 0,
  };
}

/* ---------------------------------------------------------------------------------------------
 * Web T4 dynamic behaviour — Host side (docs/t4-dynamic-behavior.md).
 *
 * Division of labour: this Host layer owns the *real* frame intake (the one shared CDP
 * screencast), the bounded enqueue/ACK accounting, the session state machine, the mapping
 * snapshot and the tool surface. Every pixel/timeline/analysis algorithm lives in the pure
 * `dynamic-t4.js` module (executor-A) so it can be unit tested without a browser. The Host never
 * decodes a JPEG: it hands the raw base64 payload + metadata to the core store, which decodes
 * (`decodeJpegRgba`) and keeps `encodedSha256`/`rgbaSha256` separately.
 *
 * Invariants enforced here:
 *  - exactly one screencast coordinator per Runtime: the page start still sends the single
 *    `Page.startScreencast` (preview JPEG/72/1600×1200) and the T4 sink only *taps* it;
 *    T4 never sends start/stop/ACK on its own.
 *  - the T4 sink receives the raw params BEFORE the preview latest-frame overwrite.
 *  - a sink failure is counted and suppressed: it can never block `frames.accept()` or the ACK.
 *  - one active dynamic session per scope; a pure-network view (captureVisual:false) creates no
 *    page, takes no page lease and never starts/stops the referenced P0 session.
 * ------------------------------------------------------------------------------------------- */

export const DYNAMIC_VERSION = 1;

export const DYNAMIC_ALGORITHM_VERSION = 't4-draft-v1';
/**
 * The five frozen T4 tool names (docs/t4-dynamic-behavior.md / implementation contract §2).
 * `DYNAMIC_REGISTERED_TOOLS` is the subset actually registered at this build; it is the ONLY
 * source for the capability report (never a manifest expectation).
 */

export const DYNAMIC_TOOL_NAMES = Object.freeze([
  'browser_dynamic_session', 'browser_motion_observe', 'browser_motion_analyze',
  'browser_motion_control', 'browser_dynamic_correlate',
]);

export const DYNAMIC_REGISTERED_TOOLS = Object.freeze([
  'browser_dynamic_session', 'browser_motion_observe', 'browser_motion_analyze',
  'browser_motion_control', 'browser_dynamic_correlate',
]);

export const DYNAMIC_MILESTONE = 'M3';

/** Per-tool constraints for browser_capabilities; each says what the registered tool really does. */

/** Per-tool constraints for browser_capabilities; each says what the registered tool really does. */
export function dynamicCapabilityConstraints(name) {
  const common = [
    'T4 group: one shared dynamic session per scope; stored observe/analyze never ensure or renew a lease',
    'no second screencast controller: the T1 preview stream is tapped before latest-frame overwrite',
    'unknown/missing evidence is INCONCLUSIVE/BLOCKED, never a PASS; temporal proximity is not causality',
  ];
  if (name === 'dynamic-session') {
    return [...common,
      'visual start/stop/reset are page operations (single-owner lease); status and pure-network views are Host-memory only',
      'screencast=shared preview JPEG (no stop/restart, explicit png/region/non-1 scale refused by name)',
      'captureVisual:false requires an existing P0 network session; never starts/stops P0',
    ];
  }
  if (name === 'motion-observe') {
    return [...common, 'stored reads are read-only; fresh=true is the only explicit page sample'];
  }
  if (name === 'motion-analyze') {
    return [...common, 'offline: analyzes stored immutable frames only; never captures a new frame'];
  }
  return common;
}

export const DYNAMIC_SESSION_ACTIONS = Object.freeze(['start', 'stop', 'status', 'reset', 'extend']);

export const DYNAMIC_SOURCES = Object.freeze(['screencast', 'screenshot-loop']);

export const DYNAMIC_ENCODINGS = Object.freeze(['png', 'jpeg']);

export const DYNAMIC_DIRECTIONS = Object.freeze([
  'operation->visual', 'operation->network', 'network->visual',
  'visual->network', 'network->network', 'visual->visual',
]);

export const DYNAMIC_ASSERTION_TYPES = Object.freeze([
  'frame-diff', 'region-change', 'flicker', 'freeze', 'jank', 'trajectory', 'transition',
]);

export const DYNAMIC_BASES = Object.freeze(['explicit', 'redirect', 'initiator', 'observed', 'temporal']);

export const DYNAMIC_GRADES = Object.freeze(['confirmed-causal', 'observed-association', 'temporal-proximity']);
/**
 * T4_LIMITS names are fixed by docs/t4-dynamic-behavior.md and are projected verbatim
 * into `limits.dynamic`; defaults and hard caps stay separate so a default is never reported as a
 * hard limit. Values below are the frozen contract numbers.
 */

export const T4_LIMITS = Object.freeze({
  maxActiveSessions: 1,
  retainedSessions: 4,
  durationMs: 3000,
  // Lead+advisor freeze (2026-11-04): a single Agent tool round-trip can exceed 10s, so the hard
  // session cap is 60s. This adds NO extend/keepalive: `fresh` and an idempotent `start` never
  // extend a running session, frame/byte/algorithm budgets do not scale with duration
  // (180/300 frames, 32/64 MiB, 5000ms), recalibrateAfterMs stays 10000, and motion-control
  // timeMs plus analysis threshold bounds stay 0–10000ms.
  durationMsHard: 60000,
  maxFrames: 180,
  maxFramesHard: 300,
  maxBytes: 33554432,
  maxBytesHard: 67108864,
  maxFramePixels: 4000000,
  maxFrameBytes: 8388608,
  maxEvents: 5000,
  maxEventsHard: 20000,
  maxRegions: 100,
  maxEvidenceBytes: 262144,
  maxWorkingSetBytes: 268435456,
  algorithmBudgetMs: 5000,
  correlationPageSize: 200,
  maxCandidateCompares: 40000,
  correlationBeforeMs: 250,
  correlationAfterMs: 1000,
  maxCorrelationBeforeMs: 5000,
  maxCorrelationAfterMs: 5000,
  maxCalibrationSamples: 5,
  maxClockUncertaintyMs: 10,
  recalibrateAfterMs: 10000,
  maxImagesPerObserve: 3,
  sampleIntervalMsMin: 50,
  sampleIntervalMsMax: 1000,
  scaleMin: 0.1,
  scaleMax: 2,
  maxControlTargets: 20,
  maxSessionExtendMs: 60000,
  sessionCapMs: 300000,
  maxAssertions: 20,
  maxIds: 200,
  maxMasks: 64,
});

export const DYNAMIC_LIMITS = T4_LIMITS;
/** Host-only delivery/query budgets (not part of the frozen T4_LIMITS projection). */

/** Host-only delivery/query budgets (not part of the frozen T4_LIMITS projection). */
export const DYNAMIC_INTERNAL = Object.freeze({
  observeLimit: 50,
  observeLimitMax: 200,
  maxIdBytes: 128,
  imageBytes: 262144,
  imageBytesTotal: 524288,
  maxStep: 10000,
  // TOOL-P1-03: bounded host-side sampling trace for session/observe/capabilities projections.
  samplingTraceMax: 240,
});

export const DYNAMIC_ASSERTION_THRESHOLDS = Object.freeze({
  'frame-diff': Object.freeze(['pixelThreshold', 'changeRatio']),
  'region-change': Object.freeze(['pixelThreshold', 'changeRatio', 'minArea']),
  flicker: Object.freeze(['pixelThreshold', 'changeRatio', 'stableRatio', 'brightnessDelta', 'maxDurationMs']),
  freeze: Object.freeze(['pixelThreshold', 'stableRatio', 'minDurationMs']),
  jank: Object.freeze(['intervalFactor']),
  trajectory: Object.freeze(['maxStep']),
  transition: Object.freeze(['pixelThreshold', 'changeRatio', 'stableRatio', 'stableSamples']),
});

export const DYNAMIC_ASSERTION_FIELDS = Object.freeze([
  'id', 'type', 'region', 'masks', 'thresholds', 'expectedIntervalMs', 'query', 'expectation',
]);

export const DYNAMIC_CONFIG_FIELDS = Object.freeze([
  'captureVisual', 'networkSessionId', 'source', 'encoding', 'durationMs', 'maxFrames',
  'maxBytes', 'region', 'scale', 'sampleIntervalMs',
]);

/** Opaque Host ids; the ID domain is (scope, dynamicSessionId, frameSeq), never a CDP id. */

/** Opaque Host ids; the ID domain is (scope, dynamicSessionId, frameSeq), never a CDP id. */
export function newDynamicSessionId() { return 'dyn_' + randomUUID().replace(/-/gu, ''); }

export function newMotionSessionId() { return 'mot_' + randomUUID().replace(/-/gu, ''); }

export function newDynamicFrameId() { return 'frm_' + randomUUID().replace(/-/gu, '').slice(0, 24); }

export function dynamicMonoNow() { return performance.now(); }

export function dynamicSha256(bytes) { return createHash('sha256').update(bytes).digest('hex'); }

/**
 * TOOL-P1-03 Host-side measured sampling stats over a contiguous time series (monotonic ms).
 * Pure: no store/CDP access, no rounding of raw values. `p50Ms/p95Ms` use the same nearest-rank
 * convention as the core jank metrics so Host and core projections cannot disagree on cadence.
 */

export function dynamicIntervalStats(times) {
  const finite = Array.isArray(times) ? times.filter((value) => Number.isFinite(value)) : [];
  const stats = {
    frames: finite.length, intervals: 0,
    p50Ms: null, p95Ms: null, minMs: null, maxMs: null, meanMs: null,
    windowMs: null, effectiveFps: null,
  };
  if (finite.length < 2) return stats;
  const intervals = [];
  for (let index = 1; index < finite.length; index += 1) intervals.push(finite[index] - finite[index - 1]);
  const sorted = [...intervals].sort((left, right) => left - right);
  const at = (percentile) => sorted[Math.min(sorted.length - 1, Math.max(0, Math.ceil((percentile / 100) * sorted.length) - 1))];
  const sum = intervals.reduce((total, value) => total + value, 0);
  const windowMs = finite[finite.length - 1] - finite[0];
  stats.intervals = intervals.length;
  stats.p50Ms = at(50);
  stats.p95Ms = at(95);
  stats.minMs = sorted[0];
  stats.maxMs = sorted[sorted.length - 1];
  stats.meanMs = sum / intervals.length;
  stats.windowMs = windowMs;
  stats.effectiveFps = windowMs > 0 ? (intervals.length / windowMs) * 1000 : null;
  return stats;
}

/** Lossless JSON projection for capability reports (never emit functions/symbols/undefined). */

/** Lossless JSON projection for capability reports (never emit functions/symbols/undefined). */
export function dynamicJsonProjection(value) {
  return value === undefined || value === null ? null : JSON.parse(JSON.stringify(value));
}

/** Strict DYNAMIC_* key check (a dynamic refusal must never surface as NET_/INVALID_ARGUMENT). */

/** Strict DYNAMIC_* key check (a dynamic refusal must never surface as NET_/INVALID_ARGUMENT). */
export function assertDynamicKeys(value, allowed, label) {
  if (value === undefined || value === null) return {};
  if (typeof value !== 'object' || Array.isArray(value)) {
    throw new BrowserError('DYNAMIC_INVALID_ARGUMENT', label + ' 必须是对象', { label });
  }
  for (const key of Object.keys(value)) {
    if (!allowed.includes(key)) {
      throw new BrowserError('DYNAMIC_INVALID_ARGUMENT', label + ' 含未知字段 ' + key, { field: key, allowed: [...allowed] });
    }
  }
  return value;
}

export function dynamicFinite(value, label) {
  if (typeof value !== 'number' || !Number.isFinite(value)) {
    throw new BrowserError('DYNAMIC_INVALID_ARGUMENT', label + ' 必须是有限数字', { field: label });
  }
  return value;
}

export function dynamicInteger(value, label, min, max) {
  dynamicFinite(value, label);
  if (!Number.isInteger(value) || value < min || value > max) {
    throw new BrowserError('DYNAMIC_INVALID_ARGUMENT', label + ' 必须是 ' + min + '–' + max + ' 的整数', { field: label, min, max, value });
  }
  return value;
}

/** Canvas CSS rect (config region) or integer PixelRect (assertion region). */

/** Canvas CSS rect (config region) or integer PixelRect (assertion region). */
export function dynamicRect(value, label, { integer = false } = {}) {
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    throw new BrowserError('DYNAMIC_INVALID_ARGUMENT', label + ' 必须是 {x,y,width,height}', { field: label });
  }
  assertDynamicKeys(value, ['x', 'y', 'width', 'height'], label);
  const rect = { x: value.x, y: value.y, width: value.width, height: value.height };
  for (const [key, raw] of Object.entries(rect)) {
    if (typeof raw !== 'number' || !Number.isFinite(raw)) {
      throw new BrowserError('DYNAMIC_INVALID_ARGUMENT', label + '.' + key + ' 必须是有限数字', { field: label + '.' + key });
    }
    if (integer && !Number.isInteger(raw)) {
      throw new BrowserError('DYNAMIC_INVALID_ARGUMENT', label + '.' + key + ' 必须是整数', { field: label + '.' + key });
    }
  }
  if (integer && (rect.x < 0 || rect.y < 0)) {
    throw new BrowserError('DYNAMIC_INVALID_ARGUMENT', label + ' 的 x/y 必须是 ≥0 的整数', { field: label, value: rect });
  }
  if (rect.width < 1 || rect.height < 1) {
    throw new BrowserError('DYNAMIC_INVALID_ARGUMENT', label + ' 宽高必须 ≥ 1', { field: label });
  }
  const pixels = Math.round(rect.width) * Math.round(rect.height);
  if (pixels > DYNAMIC_LIMITS.maxFramePixels) {
    throw new BrowserError('DYNAMIC_LIMIT_EXCEEDED', label + ' 像素超过上限', { field: label, pixels, max: DYNAMIC_LIMITS.maxFramePixels });
  }
  return rect;
}

/** A bounded, de-duplicated, same-scope opaque id list (frames/events/adapters). */

/** A bounded, de-duplicated, same-scope opaque id list (frames/events/adapters). */
export function dynamicIdList(value, label, max) {
  if (value === undefined) return null;
  if (!Array.isArray(value)) throw new BrowserError('DYNAMIC_INVALID_ARGUMENT', label + ' 必须是数组', { field: label });
  if (value.length > max) throw new BrowserError('DYNAMIC_LIMIT_EXCEEDED', label + ' 数量超过上限', { field: label, count: value.length, max });
  const list = [];
  const seen = new Set();
  for (const item of value) {
    if (typeof item !== 'string' || item === '' || Buffer.byteLength(item, 'utf8') > DYNAMIC_INTERNAL.maxIdBytes) {
      throw new BrowserError('DYNAMIC_INVALID_ARGUMENT', label + ' 含非法 id（≤' + DYNAMIC_INTERNAL.maxIdBytes + ' 字节字符串）', { field: label });
    }
    if (seen.has(item)) continue;
    seen.add(item);
    list.push(item);
  }
  return list;
}

/** Config → closed normalized shape. Pure: any refusal costs zero CDP start, zero sink. */

/** Config → closed normalized shape. Pure: any refusal costs zero CDP start, zero sink. */
export function normalizeDynamicConfig(input, { viewScale, activeEncoding }) {
  const raw = assertDynamicKeys(input || {}, DYNAMIC_CONFIG_FIELDS, 'config');
  const captureVisual = raw.captureVisual === undefined ? true : raw.captureVisual;
  if (typeof captureVisual !== 'boolean') {
    throw new BrowserError('DYNAMIC_INVALID_ARGUMENT', 'config.captureVisual 必须是布尔值', { field: 'config.captureVisual' });
  }
  const config = {
    captureVisual,
    networkSessionId: null,
    source: null,
    encoding: null,
    // Contract defaults: durationMs 3000 / maxFrames 180 / maxBytes 32 MiB / scale 1.
    durationMs: DYNAMIC_LIMITS.durationMs,
    maxFrames: DYNAMIC_LIMITS.maxFrames,
    maxBytes: DYNAMIC_LIMITS.maxBytes,
    region: null,
    scale: 1,
    sampleIntervalMs: null,
    // Resolved only by the Host at start; echoed in evidence for audit (never a caller guess).
    resolvedViewScale: viewScale,
  };
  if (raw.networkSessionId !== undefined && raw.networkSessionId !== null) {
    if (typeof raw.networkSessionId !== 'string' || raw.networkSessionId === '' || Buffer.byteLength(raw.networkSessionId, 'utf8') > DYNAMIC_INTERNAL.maxIdBytes) {
      throw new BrowserError('DYNAMIC_INVALID_ARGUMENT', 'config.networkSessionId 必须是 ≤' + DYNAMIC_INTERNAL.maxIdBytes + ' 字节的字符串', { field: 'config.networkSessionId' });
    }
    config.networkSessionId = raw.networkSessionId;
  }
  if (raw.durationMs !== undefined) {
    config.durationMs = dynamicInteger(raw.durationMs, 'config.durationMs', 1, DYNAMIC_LIMITS.durationMsHard);
  }
  if (raw.maxFrames !== undefined) {
    config.maxFrames = dynamicInteger(raw.maxFrames, 'config.maxFrames', 1, DYNAMIC_LIMITS.maxFramesHard);
  }
  if (raw.maxBytes !== undefined) {
    config.maxBytes = dynamicInteger(raw.maxBytes, 'config.maxBytes', 1, DYNAMIC_LIMITS.maxBytesHard);
  }
  if (raw.region !== undefined) config.region = dynamicRect(raw.region, 'config.region');
  if (raw.scale !== undefined) {
    dynamicFinite(raw.scale, 'config.scale');
    if (raw.scale < DYNAMIC_LIMITS.scaleMin || raw.scale > DYNAMIC_LIMITS.scaleMax) {
      throw new BrowserError('DYNAMIC_INVALID_ARGUMENT', 'config.scale 必须在 ' + DYNAMIC_LIMITS.scaleMin + '–' + DYNAMIC_LIMITS.scaleMax, { field: 'config.scale', value: raw.scale });
    }
    config.scale = raw.scale;
  }
  if (!captureVisual) {
    // Pure network correlation view: exactly captureVisual:false + networkSessionId; no frame
    // source, no encoding, no duration, no sampling knobs.
    const forbidden = ['source', 'encoding', 'durationMs', 'maxFrames', 'maxBytes', 'region', 'scale', 'sampleIntervalMs']
      .filter((key) => raw[key] !== undefined);
    if (forbidden.length) {
      throw new BrowserError('DYNAMIC_INVALID_ARGUMENT', 'captureVisual:false 时不允许字段 ' + forbidden.join(','), { fields: forbidden });
    }
    if (!config.networkSessionId) {
      throw new BrowserError('DYNAMIC_INVALID_ARGUMENT', 'captureVisual:false 必须给 networkSessionId', { field: 'config.networkSessionId' });
    }
    return config;
  }
  if (raw.source === undefined) {
    throw new BrowserError('DYNAMIC_INVALID_ARGUMENT', 'captureVisual:true 必须给 config.source', { field: 'config.source', allowed: [...DYNAMIC_SOURCES] });
  }
  if (!DYNAMIC_SOURCES.includes(raw.source)) {
    throw new BrowserError('DYNAMIC_INVALID_ARGUMENT', 'config.source 不合法', { field: 'config.source', allowed: [...DYNAMIC_SOURCES] });
  }
  config.source = raw.source;
  if (raw.encoding !== undefined && !DYNAMIC_ENCODINGS.includes(raw.encoding)) {
    throw new BrowserError('DYNAMIC_INVALID_ARGUMENT', 'config.encoding 不合法', { field: 'config.encoding', allowed: [...DYNAMIC_ENCODINGS] });
  }
  const requestedEncoding = raw.encoding === undefined ? null : raw.encoding;
  if (config.source === 'screencast') {
    // Contract §4.4: the shared preview stream is not reconfigured. An explicit request it cannot
    // satisfy is refused by name (DYNAMIC_SOURCE_UNAVAILABLE), never silently downgraded and never
    // answered with a start/stop of the preview stream.
    if (requestedEncoding === 'png') {
      throw new BrowserError('DYNAMIC_SOURCE_UNAVAILABLE', '共享 screencast 只提供 jpeg 编码（预览流不可停/不可重启）', {
        reason: 'encoding-conflict', requestedEncoding: 'png', activeEncoding: 'jpeg', supported: ['jpeg'], previewPreserved: true,
      });
    }
    config.encoding = activeEncoding || 'jpeg';
    if (raw.region !== undefined) {
      throw new BrowserError('DYNAMIC_SOURCE_UNAVAILABLE', '共享 screencast 不支持 config.region', {
        reason: 'screencast-mode-conflict', field: 'config.region', previewPreserved: true,
      });
    }
    if (config.scale !== 1) {
      throw new BrowserError('DYNAMIC_SOURCE_UNAVAILABLE', '共享 screencast 首版只接受 scale:1', {
        reason: 'screencast-mode-conflict', field: 'config.scale', value: config.scale, previewPreserved: true,
      });
    }
    if (raw.sampleIntervalMs !== undefined) {
      throw new BrowserError('DYNAMIC_INVALID_ARGUMENT', 'sampleIntervalMs 只对 screenshot-loop 适用', { field: 'config.sampleIntervalMs' });
    }
  } else {
    if (requestedEncoding === 'jpeg') {
      throw new BrowserError('DYNAMIC_SOURCE_UNAVAILABLE', 'screenshot-loop 只提供 png 编码', {
        reason: 'encoding-conflict', requestedEncoding: 'jpeg', activeEncoding: 'png', supported: ['png'],
      });
    }
    config.encoding = 'png';
    if (raw.sampleIntervalMs === undefined) {
      throw new BrowserError('DYNAMIC_INVALID_ARGUMENT', 'screenshot-loop 必须给 sampleIntervalMs', { field: 'config.sampleIntervalMs' });
    }
    config.sampleIntervalMs = dynamicInteger(raw.sampleIntervalMs, 'config.sampleIntervalMs', DYNAMIC_LIMITS.sampleIntervalMsMin, DYNAMIC_LIMITS.sampleIntervalMsMax);
  }
  return config;
}

/** Stable comparison key for the documented idempotent `start` (same name + same config). */

/** Stable comparison key for the documented idempotent `start` (same name + same config). */
export function dynamicConfigKey(config) {
  return JSON.stringify([
    config.captureVisual, config.networkSessionId, config.source, config.encoding,
    config.durationMs, config.maxFrames, config.maxBytes, config.region, config.scale, config.sampleIntervalMs,
  ]);
}

/** Assertion validation (closed shapes, §7.2). Runs before any store read. */

/** Assertion validation (closed shapes, §7.2). Runs before any store read. */
export function normalizeDynamicAssertions(value) {
  if (!Array.isArray(value) || value.length === 0) {
    throw new BrowserError('DYNAMIC_INVALID_ARGUMENT', 'assertions 必须是 1–' + DYNAMIC_LIMITS.maxAssertions + ' 条数组', { field: 'assertions' });
  }
  if (value.length > DYNAMIC_LIMITS.maxAssertions) {
    throw new BrowserError('DYNAMIC_LIMIT_EXCEEDED', 'assertions 数量超过上限', { field: 'assertions', count: value.length, max: DYNAMIC_LIMITS.maxAssertions });
  }
  const seen = new Set();
  return value.map((item, index) => {
    const label = 'assertions[' + index + ']';
    if (!item || typeof item !== 'object' || Array.isArray(item)) {
      throw new BrowserError('DYNAMIC_INVALID_ARGUMENT', label + ' 必须是对象', { field: label });
    }
    assertDynamicKeys(item, DYNAMIC_ASSERTION_FIELDS, label);
    const id = item.id;
    if (typeof id !== 'string' || id === '' || Buffer.byteLength(id, 'utf8') > 64) {
      throw new BrowserError('DYNAMIC_INVALID_ARGUMENT', label + '.id 必须是 ≤64 字节的非空字符串', { field: label + '.id' });
    }
    if (seen.has(id)) throw new BrowserError('DYNAMIC_INVALID_ARGUMENT', 'assertion id 重复: ' + id, { field: label + '.id' });
    seen.add(id);
    if (!DYNAMIC_ASSERTION_TYPES.includes(item.type)) {
      throw new BrowserError('DYNAMIC_INVALID_ARGUMENT', label + '.type 不合法', { field: label + '.type', allowed: [...DYNAMIC_ASSERTION_TYPES] });
    }
    const allowed = DYNAMIC_ASSERTION_THRESHOLDS[item.type];
    const assertion = { id, type: item.type };
    if (item.region !== undefined) assertion.region = dynamicRect(item.region, label + '.region', { integer: true });
    if (item.masks !== undefined) {
      if (!Array.isArray(item.masks) || item.masks.length > DYNAMIC_LIMITS.maxMasks) {
        throw new BrowserError('DYNAMIC_INVALID_ARGUMENT', label + '.masks 必须是 ≤' + DYNAMIC_LIMITS.maxMasks + ' 的数组', { field: label + '.masks' });
      }
      assertion.masks = item.masks.map((mask, maskIndex) => {
        const maskLabel = label + '.masks[' + maskIndex + ']';
        if (!mask || typeof mask !== 'object' || Array.isArray(mask)) {
          throw new BrowserError('DYNAMIC_INVALID_ARGUMENT', maskLabel + ' 必须是对象', { field: maskLabel });
        }
        assertDynamicKeys(mask, ['id', 'region'], maskLabel);
        if (typeof mask.id !== 'string' || mask.id === '') {
          throw new BrowserError('DYNAMIC_INVALID_ARGUMENT', maskLabel + '.id 必须是非空字符串', { field: maskLabel + '.id' });
        }
        return { id: mask.id, region: dynamicRect(mask.region, maskLabel + '.region', { integer: true }) };
      });
    }
    if (item.thresholds !== undefined) {
      assertDynamicKeys(item.thresholds, allowed, label + '.thresholds');
      assertion.thresholds = { ...item.thresholds };
      for (const [key, raw] of Object.entries(assertion.thresholds)) {
        dynamicFinite(raw, label + '.thresholds.' + key);
        const ratio = ['pixelThreshold', 'changeRatio', 'stableRatio'].includes(key);
        if (ratio && (raw < 0 || raw > 1)) {
          throw new BrowserError('DYNAMIC_INVALID_ARGUMENT', label + '.thresholds.' + key + ' 必须在 [0,1]', { field: label + '.thresholds.' + key });
        }
        if (key === 'brightnessDelta' && (raw < 0 || raw > 255)) {
          throw new BrowserError('DYNAMIC_INVALID_ARGUMENT', label + '.thresholds.brightnessDelta 必须在 [0,255]', { field: label + '.thresholds.brightnessDelta' });
        }
        if (['maxDurationMs', 'minDurationMs'].includes(key) && (raw < 0 || raw > 10000)) {
          throw new BrowserError('DYNAMIC_INVALID_ARGUMENT', label + '.thresholds.' + key + ' 必须在 [0,10000]', { field: label + '.thresholds.' + key });
        }
        if (key === 'minArea' && (!Number.isInteger(raw) || raw <= 0)) {
          throw new BrowserError('DYNAMIC_INVALID_ARGUMENT', label + '.thresholds.minArea 必须是正整数', { field: label + '.thresholds.minArea' });
        }
        if (key === 'intervalFactor' && (raw < 1 || raw > 10)) {
          throw new BrowserError('DYNAMIC_INVALID_ARGUMENT', label + '.thresholds.intervalFactor 必须在 [1,10]', { field: label + '.thresholds.intervalFactor' });
        }
        if (key === 'stableSamples' && (!Number.isInteger(raw) || raw < 2 || raw > 20)) {
          throw new BrowserError('DYNAMIC_INVALID_ARGUMENT', label + '.thresholds.stableSamples 必须在 [2,20]', { field: label + '.thresholds.stableSamples' });
        }
        if (key === 'maxStep' && raw <= 0) {
          throw new BrowserError('DYNAMIC_INVALID_ARGUMENT', label + '.thresholds.maxStep 必须是正数', { field: label + '.thresholds.maxStep' });
        }
      }
    }
    if (item.expectedIntervalMs !== undefined) {
      if (item.type !== 'jank') throw new BrowserError('DYNAMIC_INVALID_ARGUMENT', label + '.expectedIntervalMs 只对 jank 适用', { field: label + '.expectedIntervalMs' });
      dynamicFinite(item.expectedIntervalMs, label + '.expectedIntervalMs');
      if (item.expectedIntervalMs <= 0 || item.expectedIntervalMs > 10000) {
        throw new BrowserError('DYNAMIC_INVALID_ARGUMENT', label + '.expectedIntervalMs 必须在 (0,10000]', { field: label + '.expectedIntervalMs', value: item.expectedIntervalMs });
      }
      assertion.expectedIntervalMs = item.expectedIntervalMs;
    } else if (item.type === 'jank') {
      throw new BrowserError('DYNAMIC_INVALID_ARGUMENT', label + '.expectedIntervalMs 对 jank 必填', { field: label + '.expectedIntervalMs' });
    }
    if (item.query !== undefined) {
      if (item.type !== 'trajectory') throw new BrowserError('DYNAMIC_INVALID_ARGUMENT', label + '.query 只对 trajectory 适用', { field: label + '.query' });
      const query = item.query;
      if (!query || typeof query !== 'object' || Array.isArray(query)) {
        throw new BrowserError('DYNAMIC_INVALID_ARGUMENT', label + '.query 必须是对象', { field: label + '.query' });
      }
      const allowedQuery = query.method === 'template' ? ['method', 'productId', 'minScore', 'stride', 'maxResults'] : ['method', 'color', 'tolerance', 'minArea', 'maxResults'];
      assertDynamicKeys(query, allowedQuery, label + '.query');
      if (!['color', 'template'].includes(query.method)) {
        throw new BrowserError('DYNAMIC_INVALID_ARGUMENT', label + '.query.method 不合法', { field: label + '.query.method', allowed: ['color', 'template'] });
      }
      assertion.query = { ...query };
    } else if (item.type === 'trajectory') {
      throw new BrowserError('DYNAMIC_INVALID_ARGUMENT', label + '.query 对 trajectory 必填', { field: label + '.query' });
    }
    if (item.expectation !== undefined) {
      if (item.type !== 'freeze') throw new BrowserError('DYNAMIC_INVALID_ARGUMENT', label + '.expectation 只对 freeze 适用', { field: label + '.expectation' });
      const expectation = item.expectation;
      if (!expectation || typeof expectation !== 'object' || Array.isArray(expectation)) {
        throw new BrowserError('DYNAMIC_INVALID_ARGUMENT', label + '.expectation 必须是对象', { field: label + '.expectation' });
      }
      assertDynamicKeys(expectation, ['motionExpected', 'sourceEventId', 'referenceEventIds'], label + '.expectation');
      if (expectation.motionExpected !== true) {
        throw new BrowserError('DYNAMIC_INVALID_ARGUMENT', label + '.expectation.motionExpected 必须为 true', { field: label + '.expectation.motionExpected' });
      }
      if (typeof expectation.sourceEventId !== 'string' || expectation.sourceEventId === '') {
        throw new BrowserError('DYNAMIC_INVALID_ARGUMENT', label + '.expectation.sourceEventId 必须是非空字符串', { field: label + '.expectation.sourceEventId' });
      }
      const refs = dynamicIdList(expectation.referenceEventIds, label + '.expectation.referenceEventIds', 50);
      if (!refs || refs.length === 0) {
        throw new BrowserError('DYNAMIC_INVALID_ARGUMENT', label + '.expectation.referenceEventIds 至少 1 条', { field: label + '.expectation.referenceEventIds' });
      }
      assertion.expectation = { motionExpected: true, sourceEventId: expectation.sourceEventId, referenceEventIds: refs };
    } else if (item.type === 'freeze') {
      throw new BrowserError('DYNAMIC_INVALID_ARGUMENT', label + '.expectation 对 freeze 必填', { field: label + '.expectation' });
    }
    return assertion;
  });
}

/**
 * Raw CDP source timestamp. The implementation contract (§6.2) fixes `sourceTimestamp` in the
 * frame store as **seconds**: the value is preserved as CDP reports it (`metadata.timestamp`,
 * epoch seconds), never converted, never filled with receive time. A value that is implausibly
 * large to be epoch seconds is normalized to seconds and the unit stays documented as seconds.
 */

export function dynamicSourceTimestamp(metadata) {
  const raw = metadata && metadata.timestamp;
  const value = Number(raw);
  if (!Number.isFinite(value) || value <= 0) return null;
  return value >= 1e12 ? value / 1000 : value;
}

/**
 * Control adapter script (Host-owned page adapter, not CDP hand-wiring): lists WAAPI animations,
 * reads their real state, applies one control action and reads the state back. Only documented
 * fields cross the boundary; no page text, no free-form objects, no eval of caller input.
 */

export const DYNAMIC_CONTROL_ADAPTER_FN = `(function (payload) {
  const action = String(payload.action || '');
  const ids = Array.isArray(payload.targetIds) ? payload.targetIds : null;
  const all = document.getAnimations();
  const uniqueSelector = (element) => {
    if (!element || element.nodeType !== 1) return null;
    if (element.id) {
      const matches = document.querySelectorAll('#' + CSS.escape(element.id));
      if (matches.length === 1) return '#' + element.id;
    }
    return null;
  };
  const describe = (animation, index, requestedId) => {
    let durationMs = null;
    try {
      const timing = animation.effect && animation.effect.getComputedTiming ? animation.effect.getComputedTiming() : null;
      if (timing && Number.isFinite(Number(timing.duration))) durationMs = Number(timing.duration);
    } catch (error) { durationMs = null; }
    const target = animation.effect && animation.effect.target ? animation.effect.target : null;
    return {
      targetId: requestedId === undefined || requestedId === null ? 'waapi-' + index : String(requestedId),
      animationId: animation.id === undefined || animation.id === '' ? null : String(animation.id),
      animationName: animation.animationName === undefined ? null : String(animation.animationName),
      selector: uniqueSelector(target),
      playState: String(animation.playState || 'idle'),
      currentTimeMs: Number.isFinite(Number(animation.currentTime)) ? Number(animation.currentTime) : null,
      playbackRate: Number.isFinite(Number(animation.playbackRate)) ? Number(animation.playbackRate) : null,
      durationMs,
    };
  };
  const resolve = (targetId) => {
    const wanted = String(targetId);
    const byIndex = /^waapi-(\\d+)$/.exec(wanted);
    if (byIndex) {
      const index = Number(byIndex[1]);
      return Number.isInteger(index) && index >= 0 && index < all.length ? [index] : null;
    }
    const byAnimation = [];
    for (let index = 0; index < all.length; index += 1) {
      const animation = all[index];
      const animationId = animation.id === undefined || animation.id === '' ? null : String(animation.id);
      const animationName = animation.animationName === undefined ? null : String(animation.animationName);
      if (animationId === wanted || animationName === wanted) byAnimation.push(index);
    }
    if (byAnimation.length) return byAnimation;
    let element = null;
    try { element = document.querySelector(wanted); } catch (error) { return null; }
    if (!element) return null;
    const owned = [];
    for (let index = 0; index < all.length; index += 1) {
      const animation = all[index];
      if (animation.effect && animation.effect.target === element) owned.push(index);
    }
    return owned.length ? owned : null;
  };
  if (action === 'list') return { ok: true, targets: all.map((animation, index) => describe(animation, index)) };
  if (!ids || ids.length === 0) return { ok: false, code: 'TARGET_NOT_FOUND', missing: [] };
  const resolved = [];
  const missing = [];
  const ambiguous = [];
  for (const id of ids) {
    const indices = resolve(id);
    if (!indices) { missing.push(id); continue; }
    if (indices.length > 1) { ambiguous.push({ targetId: id, count: indices.length }); continue; }
    resolved.push({ targetId: String(id), index: indices[0] });
  }
  if (missing.length) return { ok: false, code: 'TARGET_NOT_FOUND', missing };
  if (ambiguous.length) return { ok: false, code: 'TARGET_AMBIGUOUS', ambiguous };
  const before = resolved.map((entry) => describe(all[entry.index], entry.index, entry.targetId));
  const applied = [];
  let failedIndex = null;
  for (let position = 0; position < resolved.length; position += 1) {
    const entry = resolved[position];
    const animation = all[entry.index];
    const original = payload.originals && payload.originals[position] ? payload.originals[position] : null;
    try {
      if (action === 'pause') animation.pause();
      else if (action === 'resume') animation.play();
      else if (action === 'seek') { animation.pause(); animation.currentTime = payload.timeMs; }
      else if (action === 'rate') animation.playbackRate = payload.rate;
      else if (action === 'restore') {
        if (!original) throw new Error('missing original');
        if (original.currentTimeMs !== null) animation.currentTime = original.currentTimeMs;
        if (original.playbackRate !== null) animation.playbackRate = original.playbackRate;
        if (original.playState === 'paused') animation.pause();
        else if (original.playState === 'running') animation.play();
      } else throw new Error('unsupported action');
      applied.push(entry.targetId);
    } catch (error) {
      failedIndex = position;
      break;
    }
  }
  return {
    ok: true,
    before,
    after: resolved.map((entry) => describe(all[entry.index], entry.index, entry.targetId)),
    applied,
    failedIndex,
  };
})`;

/** The page identity a Host action targeted: a selector/ref when the tool has one, else the URL. */

/** The page identity a Host action targeted: a selector/ref when the tool has one, else the URL. */
export function dynamicActionTarget(args, fallback) {
  if (!args || typeof args !== 'object') return fallback;
  for (const key of ['selector', 'ref']) {
    if (typeof args[key] === 'string' && args[key] !== '') return args[key];
  }
  if (args.target && typeof args.target === 'object' && typeof args.target.selector === 'string') return args.target.selector;
  return fallback;
}

/** `Window` on the dynamic timeline (contract §1): finite, fromMs ≤ toMs. */

/** `Window` on the dynamic timeline (contract §1): finite, fromMs ≤ toMs. */
export function normalizeDynamicWindow(value) {
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    throw new BrowserError('DYNAMIC_INVALID_ARGUMENT', 'window 必须是 {fromMs,toMs}', { field: 'window' });
  }
  assertDynamicKeys(value, ['fromMs', 'toMs'], 'window');
  const fromMs = dynamicFinite(value.fromMs, 'window.fromMs');
  const toMs = dynamicFinite(value.toMs, 'window.toMs');
  if (fromMs > toMs) {
    throw new BrowserError('DYNAMIC_INVALID_ARGUMENT', 'window.fromMs 不能大于 toMs', { field: 'window' });
  }
  return { fromMs, toMs };
}

/** Opaque, Host-owned observe cursor. It only carries a positional bound, never a query. */

/** Opaque, Host-owned observe cursor. It only carries a positional bound, never a query. */
export function encodeDynamicCursor(payload) {
  return 'dcur.' + Buffer.from(JSON.stringify({ v: 1, ...payload }), 'utf8').toString('base64url');
}

export function decodeDynamicCursor(cursor) {
  try {
    const text = String(cursor);
    if (!text.startsWith('dcur.')) return null;
    const parsed = JSON.parse(Buffer.from(text.slice(5), 'base64url').toString('utf8'));
    if (!parsed || parsed.v !== 1 || typeof parsed.d !== 'string' || typeof parsed.m !== 'string' || !Number.isInteger(parsed.s)) return null;
    return parsed;
  } catch { return null; }
}

export const DYNAMIC_STATUSES = Object.freeze(['PASS', 'WARN', 'FAIL', 'INCONCLUSIVE', 'BLOCKED']);

export const DYNAMIC_STATUS_RANK = Object.freeze({ PASS: 0, WARN: 1, INCONCLUSIVE: 2, BLOCKED: 3, FAIL: 4 });

export function normalizeDynamicVerdict(value, results) {
  if (typeof value === 'string' && DYNAMIC_STATUSES.includes(value)) return value;
  if (Array.isArray(results) && results.length) {
    let worst = 'PASS';
    for (const item of results) {
      const status = item && (item.verdict || item.status);
      if (typeof status === 'string' && DYNAMIC_STATUSES.includes(status)
        && DYNAMIC_STATUS_RANK[status] > DYNAMIC_STATUS_RANK[worst]) worst = status;
    }
    return worst;
  }
  return 'INCONCLUSIVE';
}

export function normalizeDynamicSummary(value, results) {
  const counts = { pass: 0, warn: 0, fail: 0, inconclusive: 0, blocked: 0 };
  if (value && typeof value === 'object') {
    for (const key of Object.keys(counts)) if (Number.isInteger(value[key])) counts[key] = value[key];
    return counts;
  }
  if (Array.isArray(results)) {
    for (const item of results) {
      const status = item && (item.verdict || item.status);
      if (status === 'PASS') counts.pass += 1;
      else if (status === 'WARN') counts.warn += 1;
      else if (status === 'FAIL') counts.fail += 1;
      else if (status === 'BLOCKED') counts.blocked += 1;
      else counts.inconclusive += 1;
    }
  }
  return counts;
}

/**
 * Split requested computed-style names into what CDP already answered and what it cannot answer.
 *
 * `CSS.getComputedStyleForNode` reports longhands only, so shorthands such as `border-color`,
 * `margin` or `font` never appear in its map even when the page has a value. Anything absent is
 * collected into `missing` for the page-side fallback instead of being returned as `undefined`.
 */

export function pickComputedStyle(map, properties) {
  const picked = {};
  const missing = [];
  for (const name of properties) {
    if (Object.prototype.hasOwnProperty.call(map, name)) picked[name] = map[name];
    else missing.push(name);
  }
  return { picked, missing };
}

/**
 * Ask the page for the property names CDP did not report. `getComputedStyle().getPropertyValue()`
 * understands both longhands and shorthands; an unknown name resolves to an empty string and stays
 * omitted (never a fabricated value). A resolve failure or a single failed evaluation degrades to
 * "not reported" instead of failing the whole read.
 *
 * @param {(method: string, params: object, signal?: AbortSignal) => Promise<any>} send CDP send
 * @param {number} nodeId CDP node id
 * @param {string[]} names property names to resolve
 * @returns {Promise<Record<string, string>>} the names the page could answer
 */

export async function readComputedStyleFallback(send, nodeId, names, signal) {
  const out = {};
  let objectId;
  try {
    const resolved = await send('DOM.resolveNode', { nodeId }, signal);
    objectId = resolved && resolved.object && resolved.object.objectId;
  } catch {
    return out;
  }
  if (!objectId) return out;
  for (const name of names) {
    try {
      const call = await send('Runtime.callFunctionOn', {
        objectId,
        functionDeclaration: 'function (name) { const value = getComputedStyle(this).getPropertyValue(name); return value === "" ? null : value; }',
        arguments: [{ value: name }],
        returnByValue: true,
        silent: true,
      }, signal);
      const value = call && call.result ? call.result.value : null;
      if (typeof value === 'string' && value !== '') out[name] = value;
    } catch {
      // A single property must not fail the whole read; it simply stays unreported.
    }
  }
  return out;
}

/**
 * Bound the inline base64 fallback of a capture.
 *
 * The value is a base64 string (4/3 of the PNG bytes); a 16M-pixel capture can exceed 40 MiB of
 * text, which the fallback render would hand to the model as one giant string. Above `limit`
 * characters the inline copy is omitted (`image: null`) while the attachment fields stay intact;
 * `omitted` lets the caller record the warning without guessing.
 *
 * @param {string|null|undefined} base64 inline base64 payload
 * @param {number} [limit] character budget (defaults to 24 MiB)
 * @returns {{image: string|null, omitted: boolean, bytes: number}}
 */

export function inlineImageDelivery(base64, limit = IMAGE_INLINE_BASE64_LIMIT) {
  const bytes = typeof base64 === 'string' ? base64.length : 0;
  if (bytes > limit) return { image: null, omitted: true, bytes };
  return { image: typeof base64 === 'string' ? base64 : null, omitted: false, bytes };
}

export class Runtime {
  #frames = null;
  #audio = null;
  #visionStore = null;
  #net = null;
  #netCtl = null;
  #securityScope = null;
  /** FR-09/FR-10: findings collected for this workspace scope (survives page navigation). */
  securityFindings = null;
  /** FR-03: collected Debugger.scriptParsed descriptors, or null while analysis is not armed. */
  scriptRegistry = null;
  /** FR-05: breakpoint book + pause guard, created on first use (no Debugger until then). */
  debugBook = null;
  debugGuard = null;
  /** The most recent pause (normalized projection), used by stack/scope/correlate actions. */
  lastPause = null;

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
    /** primary or popup child (docs/internal/popup-new-tab-policy.md). */
    this.kind = options.kind === 'popup' ? 'popup' : 'primary';
    this.parentRuntimeId = options.parentRuntimeId || null;
    this.viewId = options.viewId || 'primary';
    this.parentKey = options.parentKey || null;
    this.openEventId = options.openEventId || null;
    this.sourcePanelId = options.sourcePanelId || null;
    this.createdBy = options.createdBy || 'host';
    this.scope = options.scope || LEGACY_SCOPE.scope;
    // FR-01 Scope & Safety Controller: one ScopeStore per Runtime (= per workspace scope).
    // Created lazily by the security-scope module (the store class lives there); `null` until the
    // first `browser_security_scope` call loads the module chain, so a runtime that never tests
    // security never pays for it.
    this.#securityScope = null;
    this.ownsHost = !options.host;
    this.host = options.host || new BrowserHost(log);
    this.origins = options.origins || new Set();
    this.cdp = undefined;
    /** { targetId, generation } of this runtime's own page target (undefined when cold). */
    this.page = undefined;
    // A14: the frame source is the Web-only capture chain. Constructing it eagerly made
    // `new Runtime()` require the whole Web module graph, so a host that never captures frames
    // still paid for it (and a direct construction outside the plugin's load gate threw). It is
    // created on first use instead; a runtime that never captures never loads it.
    this.#frames = null;
    this.#audio = null;
    this.frameTransport = undefined;
    this.clientMetrics = undefined;
    this.ackFailures = 0;
    this.cdpOff = undefined;
    this.closing = undefined;
    this.network = [];
    this.requests = new Map();
    this.url = '';
    this.title = '';
    // Shared viewport authority (docs/viewport-control.md). `viewport` below is a read-only
    // alias so the historical `{width,height}` field can never drift from `view`.
    this.view = {
      version: 1,
      x: VIEW_LIMITS.default.x,
      y: VIEW_LIMITS.default.y,
      // Canvas origin C (docs/viewport-control.md): the viewport's top-left on the document canvas,
      // allowed to be negative / outside the content box. O = C - S is always derived, never stored.
      canvasX: 0,
      canvasY: 0,
      width: VIEW_LIMITS.default.width,
      height: VIEW_LIMITS.default.height,
      scale: VIEW_LIMITS.default.scale,
      source: 'default',
      revision: 0,
    };
    if (options.inheritView && options.inheritView.width > 0 && options.inheritView.height > 0) {
      // A popup starts at the parent's accepted size/scale, but with an independent O=0 position.
      this.view.width = Number(options.inheritView.width);
      this.view.height = Number(options.inheritView.height);
      this.view.scale = Number(options.inheritView.scale) || 1;
      this.view.x = 0;
      this.view.y = 0;
      this.view.canvasX = 0;
      this.view.canvasY = 0;
      this.view.source = 'default';
      this.view.revision = 0;
    }
    /** Last real `Page.getLayoutMetrics` readback (null until the page was actually observed). */
    this.observed = null;
    // Merged background observation of the layout viewport (docs/viewport-control.md): set by
    // request/action triggers only — there is deliberately no standing 5Hz timer.
    this.viewObserveTimer = 0;
    this.viewObserveDue = [];
    this.viewObserving = false;
    this.viewObserveAt = 0;
    /** Last GUI originId that wrote the view (Agent writes keep it null); diagnostics only. */
    this.viewOriginId = null;
    // P0-D annotations (docs/viewport-control.md): the last *accepted* human-panel document of
    // this Runtime. `documentKey` is the opaque navigation token the panel must echo back; it is
    // rotated (and the document dropped) on a main-document commit, main-context loss, same-document
    // URL/hash/history change, close and CDP disconnect. `panels` is the 16-slot per-key watermark
    // used for clientRevision de-duplication. `salt` keeps `addressDigest` un-reversible.
    this.annot = {
      document: null,
      revision: 0,
      documentKey: null,
      panels: new Map(),
      lastSeenAt: 0,
      updatedAt: null,
      lastRotateReason: null,
      salt: randomUUID().replace(/-/gu, ''),
      // Human-foreground claim (`browser_annotation`, docs/viewport-control.md): the panel reports
      // "this runtime is my selected tab and I am visible" on its authenticated requests. It is a
      // separate clock from `lastSeenAt` (document freshness) and from the 15s viewer TTL.
      guiForegroundAt: 0,
      guiForegroundView: null,
    };
    this.activity = '空闲';
    this.agentUntil = 0;
    this.humanUntil = 0;
    this.lastError = '';
    this.lastErrorAt = 0;
    this.lastErrorActionId = null;
    this.lastErrorTarget = null;
    this.starting = undefined;
    this.queue = Promise.resolve();
    // Cross-environment lifecycle (A12): a config transition that removes the Web selection for
    // this page's scope must cancel queued/running operations instead of letting them mutate a
    // page the environment no longer owns. The composed signal is what `run()` observes.
    this.envController = new AbortController();
    this.envAbortReason = null;
    this.lease = undefined;
    this.active = 0;
    // `browser_input` state (docs/tools.md): the keys this page currently holds down and the
    // virtual cursor position used by relative mouse moves. Both die with the document.
    this.inputState = { keys: new Map(), cursor: null };
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
    // Page audio tap (docs/web/debug-panel.md): the CDP binding name the injected script calls and
    // the identifier of the document-start script, both cleared with the page.
    this.audioBinding = undefined;
    this.audioScriptId = undefined;
    this.navigationCount = 0;
    // P0 capture evidence: the last successful browser_screenshot facts (browser_capabilities
    // reports them as `capture.observed`; capabilities never starts a browser to get them).
    this.captureObservation = null;
    // Cached Browser.getVersion projection ({ product, headless }); set on first capture.
    this.productInfo = undefined;
    // Web T3 (docs/t3-vision.md): one product store per workspace scope, owned by the plugin
    // instance and independent of the page lifecycle — a page navigation/close keeps the stored
    // images analysable offline (their actionable资格 is invalidated separately). Only dispose
    // (plugin unload / runtime retire) clears it.
    this.#visionStore = null;
    // Provenance per product (runtimeId/pageGeneration/documentEpoch) so `act` can prove it is
    // operating on the same page generation, and evidence can cite the capture lineage.
    this.visionProvenance = new Map();
    // Last real vision call of this Runtime, projected into browser_capabilities.vision.observed
    // (numbers/status only — never an image, an absolute path or page text).
    this.visionObservation = null;
    // Web T2 runtime state (docs/t2-structured-gui.md, §5).
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
    // Web P0 network collection (docs/network-p0.md). One NetworkStore per Runtime (= per
    // workspace scope): the ring buffer, bodies, steps, links, artifacts and subscriptions are all
    // scope-local. `netControl` is the interception/throttle/hold state machine; `netTargets` maps
    // an auto-attached child CDP session to its target so every event can be attributed.
    // TOOL-P1-04: session attribution is a construction-time fact -- scopeId from this Runtime's
    // workspace, runtimeId its own id, tabId 'primary' for the primary runtime and the popup viewId
    // for a child tab. It is never inferred from cdpSessionId/targetId and stays stable per tab.
    // A14: the P0 network store/control state belong to the Web-only module chain; they are
    // created on first use so a runtime that never touches the network never loads them.
    this.#net = null;
    this.#netCtl = null;
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
    // The store itself is created on first network use, so the field is seeded here as data.
    this.netObserved = null;
    this.lastNetSessionId = null;
    // Web T4 dynamic behaviour (docs/t4-dynamic-behavior.md, docs/t4-dynamic-behavior.md):
    // one active session per scope, up to four retained summaries, one screencast sink, and the
    // last real T4 call projected into browser_capabilities.dynamic.observed. The core module
    // (dynamic-t4.js) is imported lazily: a T4 call loads it, and the only exception is
    // browser_capabilities.dynamic.assertions (TOOL-P1-06), which may load the pure module for its
    // JSON schema without starting a page or taking a lease; page preview/T1/T2/T3/P0 never depend on it.
    this.dynamic = {
      version: DYNAMIC_VERSION,
      session: null,
      records: [],
      sink: null,
      core: null,
      corePromise: null,
      conflicts: [],
      controlAdapters: [
        { id: 'waapi', version: '1', available: true, actions: ['pause', 'resume', 'seek', 'rate', 'restore'], restorable: true, reason: null },
        { id: 'media', version: null, available: false, actions: [], restorable: false, reason: 'media adapter not implemented in M2' },
      ],
      observed: null,
      lastOperation: null,
      started: 0,
      restored: null,
      // TOOL-P1-06: set only when browser_capabilities could not load the assertion schema.
      assertionSchemaUnavailable: null,
    };
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
   * Historical top-level alias `viewport={width,height}` (docs/viewport-control.md keeps it):
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
   * and page operations call this (coalescing concurrent requests), so the workspace being previewed/operated is
   * the one producing frames. Known limitation: with several panels open at once the previews
   * alternate instead of updating simultaneously, and the page's `visibilityState` follows.
   */
  activate(signal) {
    const cdp = this.cdp;
    if (!cdp || cdp.closed) return Promise.resolve(false);
    const host = this.host;
    // On Linux an offscreen mapped window can still take desktop focus. Only ask Chrome to
    // select its internal tab after the X11 helper has confirmed hiding and no-input hints.
    if (host?.backgroundHeaded && (!host.windowHidden || host.ownedTargets.get(this.page?.targetId)?.initializing)) {
      return Promise.resolve(false);
    }
    // Do not use a front-tab cache: front-ness also changes *outside* this runtime (Chromium fronts a
    // freshly created tab, the user clicks another tab, a popup opens), so any "already front" cache
    // goes stale and the one call an input dispatch depends on is exactly the one that gets skipped —
    // measured on douyin: with a stale cache the tab stayed background and every press/key was
    // dropped by the renderer while `Page.bringToFront` had not been sent at all.
    // Coalescing keeps the cost at one in-flight call per burst instead of one per caller.
    if (this.activating) return this.activating;
    this.activating = (async () => {
      try {
        await cdp.send('Page.bringToFront', {}, { timeoutMs: 2000, signal });
        if (host) host.frontRuntimeId = this.runtimeId;
        return true;
      } finally {
        this.activating = null;
      }
    })();
    return this.activating;
  }

  /** Lazily created P0 network store (scope-local attribution is fixed at first use). */
  get net() {
    if (!this.#net) {
      this.#net = new network.NetworkStore({
        scopeId: this.scope.id,
        attribution: {
          scopeId: this.scope.id,
          runtimeId: this.runtimeId,
          tabId: this.kind === 'popup' ? (this.viewId || 'primary') : 'primary',
        },
      });
    }
    return this.#net;
  }

  set net(value) { this.#net = value; }

  /** Last real network tool call (`capabilities.network.observed`); null until one happens. */
  get netObserved() { return this.#net ? this.#net.observed : null; }

  set netObserved(value) { if (this.#net) this.#net.observed = value; }

  /** Lazily created interception/throttle/hold state machine. */
  get netCtl() {
    if (!this.#netCtl) this.#netCtl = new network.ControlState();
    return this.#netCtl;
  }

  set netCtl(value) { this.#netCtl = value; }

  /** Lazily created T3 product store (created on first vision use, like the frame source). */
  get visionProducts() {
    if (!this.#visionStore) this.#visionStore = new vision.VisionProductStore({ now: () => Date.now() });
    return this.#visionStore;
  }

  set visionProducts(value) { this.#visionStore = value; }

  /** Lazily created frame source (see the constructor note). Throws only when actually used. */
  get frames() {
    if (!this.#frames) this.#frames = new FrameSource();
    return this.#frames;
  }

  set frames(value) { this.#frames = value; }

  /**
   * Page audio for the panel preview (docs/web/debug-panel.md). Created on first use for the same
   * reason as the frame source: a host that never opens a page never loads the Web audio module.
   */
  get audio() {
    if (!this.#audio) this.#audio = new AudioSource({ now: () => Date.now() });
    return this.#audio;
  }

  set audio(value) { this.#audio = value; }

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
  /** Observed signal for one operation: caller cancellation plus the environment-transition gate. */
  #effectiveSignal(signal) {
    const environmentSignal = this.envController?.signal;
    if (!environmentSignal) return signal;
    if (!signal) return environmentSignal;
    return typeof AbortSignal.any === 'function' ? AbortSignal.any([signal, environmentSignal]) : signal;
  }

  /**
   * Cancel queued/running work because the configuration no longer selects this environment.
   * The controller is replaced so later operations (after re-enabling Web) are not still aborted;
   * `run()`'s ABORTED classification closes the page, releasing connection/frames/network/lease.
   */
  abortForEnvironmentChange(reason = 'config-transition') {
    if (!this.envController || this.envController.signal.aborted) return { aborted: false, reason: this.envAbortReason };
    this.envAbortReason = reason;
    try { this.envController.abort(new Error('environment changed: ' + reason)); } catch { /* best effort */ }
    this.envController = new AbortController();
    return { aborted: true, reason };
  }

  /**
   * Run one operation in the page queue.
   *
   * `activate` (default true) fronts the page so Chromium keeps compositing it — required for real
   * page operations, and the reason a panel preview follows the operated tab. A **read-only
   * observation** must pass `activate:false`: bringing a teammate's page to the front changes its
   * `visibilityState` and can stall its background frames, which is exactly the interference the
   * non-destructive-observation rule forbids. It still enters this queue (serialised with writes) —
   * only the foreground switch is skipped.
   */
  async run(operation, { signal, sessionId = 'anonymous', agent = false, action, activate = true } = {}) {
    signal = this.#effectiveSignal(signal);
    checkAbort(signal);
    this.inflight += 1;
    // Everything that can throw after the counter moved must sit inside the try/finally below:
    // a BUSY claim (another session already owns the page) used to leak `inflight` forever, which
    // in turn permanently blocked the coalesced view observation (`#runViewObservation` defers
    // while inflight > 0) — the page kept working but its scroll echo silently froze.
    const previous = this.queue;
    let unlock;
    const turn = new Promise((resolve) => { unlock = resolve; });
    this.queue = previous.then(() => turn);
    let entered = false;
    let claimed = false;
    try {
      if (agent) {
        this.claim(sessionId);
        claimed = true;
        this.activeOwner = sessionId;
        this.active += 1;
      }
      await abortable(previous, signal);
      checkAbort(signal);
      if (agent) this.claim(sessionId);
      // Front the page only when this operation has the queue. A sibling may take the front
      // while we wait. Pure observations opt out so they cannot interrupt another page's preview.
      if (activate) await this.activate(signal).catch(() => false);
      checkAbort(signal);
      entered = true;
      const result = await operation();
      checkAbort(signal);
      if (agent) this.claim(sessionId);
      if (action) this.clearError();
      return result;
    } catch (error) {
      const classified = asBrowserError(error);
      // VIEWPORT_CONFLICT is an optimistic-concurrency answer, not a page failure: like an
      // invalid argument it must not overwrite the owner's lastError (docs/viewport-control.md).
      if (entered && action && !['INVALID_ARGUMENT', 'UNSUPPORTED', 'BUSY', 'VIEWPORT_CONFLICT'].includes(classified.code)) {
        this.setError(classified.message, action);
      }
      // A rejected CDP wait cannot retract an already dispatched command. Close before allowing
      // the next writer, rather than letting that command mutate a later operation's page.
      if (entered && ['ABORTED', 'CDP_TIMEOUT', 'CDP_DISCONNECTED'].includes(classified.code)) await this.close();
      throw classified;
    } finally {
      this.inflight = Math.max(0, this.inflight - 1);
      if (claimed) {
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
    const page = await this.host.createPage(this, signal);
    return this.#initializePage(page, { signal });
  }

  /** Adopt an already-paused popup target: no createPage, guard is enabled before resume. */
  async adoptPage(page, options = {}) {
    return this.#initializePage(page, options);
  }

  /**
   * Arm the page audio tap (docs/web/debug-panel.md): one CDP binding the injected script calls
   * with each PCM packet, plus the tap source itself for every future document.
   *
   * Best effort by design: a browser that refuses the binding, a page that blocks script
   * injection or a CSP that trips the evaluate must still open normally — the panel then simply
   * reports "no audio" and stays silent.
   */
  async #audioArm(signal) {
    try {
      const binding = audioTap.AUDIO_BINDING;
      const source = audioTap.AUDIO_TAP_SOURCE;
      if (typeof binding !== 'string' || typeof source !== 'string') return;
      if (this.audioBinding !== binding) {
        await this.send('Runtime.addBinding', { name: binding }, signal);
        this.audioBinding = binding;
      }
      try {
        const added = await this.send('Page.addScriptToEvaluateOnNewDocument', { source }, signal);
        const identifier = added && typeof added.identifier === 'string' ? added.identifier : undefined;
        if (identifier) this.audioScriptId = identifier;
      } catch { /* future documents only: the current-document attempt below still runs */ }
      // The already-loaded document predates the injection; install the tap into it once.
      try {
        await this.send('Runtime.evaluate', { expression: source, silent: true, returnByValue: false }, signal);
      } catch { /* the next navigation re-installs it at document start */ }
    } catch { /* audio must never fail page start */ }
  }

  /** One PCM packet from the injected tap. Never throws into the CDP dispatcher. */
  #audioAccept(payload) {
    if (typeof payload !== 'string' || payload.length === 0) return;
    let parsed;
    try { parsed = JSON.parse(payload); } catch { this.#audioCountError(); return; }
    if (!parsed || parsed.t !== 'a') return;
    try {
      this.audio.accept(parsed);
    } catch {
      this.#audioCountError();
    }
  }

  #audioCountError() {
    try { if (this.#audio) this.#audio.counters.error += 1; } catch { /* ignore */ }
  }

  async #initializePage(page, { signal, resume } = {}) {
    const host = this.host;
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
    const adopting = typeof resume === 'function';
    try {
      // A freshly attached popup is paused in waitForDebuggerOnStart: Page.enable/Runtime.enable
      // do not answer until it is resumed. The one command that must run before resume is the
      // Document Fetch guard, so enable it first, resume through the bootstrap session, then
      // finish the normal initialisation on the still-connected page WS.
      this.netFetchKey = '';
      if (adopting) {
        const guard = await this.#netSyncFetch(signal);
        await resume();
        await this.send('Page.enable', {}, signal);
        await this.send('Runtime.enable', {}, signal);
        await this.send('Network.enable', { maxTotalBufferSize: 5000000 }, signal);
      } else {
        await this.send('Page.enable', {}, signal);
        await this.send('Runtime.enable', {}, signal);
        await this.send('Network.enable', { maxTotalBufferSize: 5000000 }, signal);
        await this.#netSyncFetch(signal);
      }
      if (this.net.running && this.netCtl.needsArm) {
        this.netCtl.needsArm = false;
        const armed = this.net.config.captureWorkers ? await this.#netArmAutoAttach(signal) : { ok: false, reason: 'capture-disabled:workers' };
        if (!armed.ok && this.net.config.captureWorkers && !this.net.issues.includes('workers-not-attributable')) {
          this.net.issues.push('workers-not-attributable');
        }
      }
      // Page audio for the panel preview: binding + injected tap (best effort, never fatal).
      await this.#audioArm(signal);
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
      // Adopted popups: the first real navigation may still be committing; read the actual address
      // once (bounded) and never substitute the intent URL for it.
      if (typeof resume === 'function') { try { await this.refreshMetadata(signal); } catch { /* pending navigation */ } }
      // Publish the fresh runtime state (history/url/title) once the page is up.
      this.refreshMetadataSoon();
      // Best effort: a page that just came up should be the compositing one, but a failed
      // bringToFront must not fail the page start (the input path verifies delivery itself).
      this.activate().catch(() => false);
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
    if (message.method === 'Runtime.bindingCalled' && this.audioBinding
      && message.params && message.params.name === this.audioBinding) {
      this.#audioAccept(message.params.payload);
      return;
    }
    if (message.method === 'Page.windowOpen') {
      try { this.host?.noteWindowOpen?.(this, message.params || {}); } catch { /* popup attribution must never break the page */ }
      return;
    }
    // Child targets (worker / OOPIF) are auto-attached on the page connection (§3.1/R1-6).
    if (message.method === 'Target.attachedToTarget' || message.method === 'Target.detachedFromTarget') {
      this.#netOnTarget(message);
      return;
    }
    // Every Network.* event feeds the P0 collector first; the legacy buffers below keep their own
    // (unchanged) bookkeeping so browser_network / P6 / P21 / T2 networkDelta never move.
    // FR-03 script inventory: Debugger.scriptParsed is collected ONLY while script analysis is
    // armed (Debugger.enable is invasive — it is opt-in per Runtime, never on by default).
    if (message.method === 'Debugger.scriptParsed' && this.scriptRegistry !== null) {
      const descriptor = scriptAnalysis.normalizeScriptDescriptor(message.params);
      if (descriptor !== null) this.scriptRegistry.push(descriptor);
    }
    // A document navigation destroys the old script ids: Chromium no longer answers
    // `Debugger.getScriptSource` for them. Keeping them in the registry made a stale id look
    // resolvable and then fail with an unclassified CDP error. Clear on main-frame commit and let
    // the new document's scriptParsed batch repopulate.
    if (message.method === 'Page.frameNavigated' && this.scriptRegistry !== null) {
      const frame = message.params?.frame ?? {};
      if (typeof frame.parentId !== 'string' || frame.parentId === '') {
        this.scriptRegistry = [];
        this.scriptGeneration = (this.scriptGeneration ?? 0) + 1;
        // A URL breakpoint is bound to the scripts of the CURRENT document: after navigation its
        // locations are gone, so a breakpoint placed before a script existed could never hit.
        // Replay every stored definition under a fresh CDP id — this is what makes "break at load
        // time" (initialization code, first request) actually possible.
        if (this.debugBook !== null) {
          const definitions = this.debugBook.definitions();
          if (definitions.length > 0) {
            void (async () => {
              for (const definition of definitions) {
                try {
                  const params = {
                    url: definition.url,
                    lineNumber: definition.lineNumber,
                    columnNumber: definition.columnNumber,
                  };
                  if (definition.condition !== null) params.condition = definition.condition;
                  const replayed = await this.send('Debugger.setBreakpointByUrl', params);
                  if (typeof replayed?.breakpointId === 'string') {
                    this.debugBook.replaceId(definition.cdpBreakpointId, replayed.breakpointId, {
                      locations: replayed.locations ?? [],
                    });
                  }
                } catch { /* a replay failure must not break navigation */ }
              }
            })();
          }
        }
      }
    }
    // FR-05: a pause is recorded with its call frames; the guard's timeout rule is enforced by
    // the action layer (which can send Debugger.resume) — this handler only records facts.
    if (message.method === 'Debugger.paused' && this.scriptRegistry !== null) {
      // The guard is created on demand: `armed` only arms the domain, and a pause can arrive
      // before any explicit breakpoint/stack call (e.g. Debugger.pause or a `debugger` statement).
      // Gating this on a pre-existing guard silently dropped every pause — measured as "breakpoint
      // resolved but hitCount stayed 0" even though the page really did pause.
      if (this.debugGuard === null) this.#debugGuardLazy();
      if (this.debugBook === null) this.#debugBookLazy();
      const params = message.params || {};
      const hitIds = Array.isArray(params.hitBreakpoints) ? params.hitBreakpoints : [];
      this.debugBook?.recordHit(hitIds);
      this.debugGuard.enter({
        reason: params.reason,
        callFrames: params.callFrames,
        hitBreakpoints: hitIds,
        atMs: Date.now(),
      });
      this.lastPause = {
        reason: typeof params.reason === 'string' ? params.reason : null,
        pausedAtMs: Date.now(),
        callFrames: (Array.isArray(params.callFrames) ? params.callFrames : []).slice(0, runtimeDebug.DEBUG_LIMITS.maxCallFrames),
        hitBreakpoints: hitIds.slice(0, 16),
        // Scope objects are kept only as OPAQUE handles for a follow-up projection; they are
        // never serialized into a tool response.
        scopeChain: (Array.isArray(params.callFrames?.[0]?.scopeChain) ? params.callFrames[0].scopeChain : []).slice(0, runtimeDebug.DEBUG_LIMITS.maxScopeObjects),
      };
    }
    if (message.method === 'Debugger.resumed' && this.debugGuard !== null) {
      this.debugGuard.resume();
    }
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
      // Web T4: tap the raw CDP frame BEFORE the preview latest-frame is overwritten. The sink only
      // enqueues (bounded); its own failures are counted and can never block the preview or ACK.
      // `receivedMonoMs` is the Host receive instant, never used as sourceTimestamp.
      const receivedMonoMs = dynamicMonoNow();
      try { this.#dynamicSinkAccept(params, receivedMonoMs); } catch { this.dynamic.conflicts.push('sink-accept'); }
      const metadata = params.metadata || {};
      const scale = metadata.pageScaleFactor || 1;
      const width = Number(metadata.deviceWidth) || this.viewport.width;
      const height = Number(metadata.deviceHeight) || this.viewport.height;
      // Capture-time top-level scroll (docs/viewport-control.md): prefer the CDP metadata, fall
      // back to the last measured S. The value is a finite non-negative number; 0 is legal.
      const scrollX = Number.isFinite(metadata.scrollOffsetX) ? metadata.scrollOffsetX : this.view.x;
      const scrollY = Number.isFinite(metadata.scrollOffsetY) ? metadata.scrollOffsetY : this.view.y;
      this.frames.accept({
        data: params.data,
        format: 'jpeg',
        width,
        height,
        pageWidth: Math.round(width / scale),
        pageHeight: Math.round(height / scale),
        scrollX,
        scrollY,
        capturedAt: metadata.timestamp,
      });
      // ACK immediately after the frame is cached: Chromium will not emit the next frame
      // until it is acknowledged. A lost ACK surfaces as stopped frames, so count failures.
      // This is the ONLY screencast ACK in the Host — the T4 sink never sends one.
      if (this.cdp) {
        this.cdp.send('Page.screencastFrameAck', { sessionId: params.sessionId }).then(() => {
          this.screencastAcks += 1;
          this.#dynamicNoteAck(true);
        }).catch((error) => {
          this.ackFailures += 1;
          this.#dynamicNoteAck(false);
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
      // A committed document starts a new audio timeline: the injected tap re-installs itself and
      // the packet sequence restarts at 1, so the panel must flush what it still holds.
      try { if (this.#audio) this.#audio.reset('navigation'); } catch { /* ignore */ }
      const dynamicSession = this.dynamic.session;
      if (dynamicSession && dynamicSession.captureVisual && dynamicSession.state === 'running') {
        this.#dynamicAppendEvent(dynamicSession, {
          domain: 'visual', kind: 'document.change', phase: 'end',
          payload: { reason: 'main-frame-commit' },
        });
      }
      // A new document has no canvas residual: O=0 (docs/viewport-control.md). C then follows the
      // browser's final scroll S through the normal coalesced readback below.
      this.#resetCanvasOnNavigation();
      // Page-state ↔ network correlation (docs/network-p0.md / G2.6): one state mark per
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
        // A same-document URL/hash/history change is still a different address for the panel's
        // annotations (docs/viewport-control.md): rotate the token and drop the document. Refs
        // deliberately keep their epoch — same-document nodes are still the same objects.
        this.#annotationRotate('history');
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
   * Web P0 network collection (docs/network-p0.md).
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
      // Capture the request body now: `loadingFinished` is not guaranteed for every request, and
      // the request body is already complete at this point.
      void this.#netCaptureRequestBodyEarly({
        targetId,
        cdpSessionId,
        requestId: params.requestId,
        hopId: hopOf(params.requestId),
        info,
      }).catch(() => { });
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
  /**
   * Capture the REQUEST body as soon as the response arrives.
   *
   * `Network.loadingFinished` is not emitted for every request (measured: a fetch POST produced
   * request/response events but no `finished`, so the body was never read and the surface had no
   * parameter model for it). The request body is already final at `responseReceived`, so it is
   * captured there, once, and the later full capture keeps its response-body work.
   */
  async #netCaptureRequestBodyEarly({ targetId, cdpSessionId, requestId, hopId, info }) {
    const cdp = this.cdp;
    if (!cdp || cdp.closed || !this.net.running) return;
    if (!this.net.config.captureBodies) return;
    const method = String(info?.method || 'GET').toUpperCase();
    if (method === 'GET' || method === 'HEAD') return;
    // Already captured (or classified): never overwrite a real record with a second attempt.
    const existing = this.net.bodyRecord({ targetId, cdpSessionId, requestId, hopId, kind: 'request' });
    if (existing !== null && existing.state !== 'empty') return;
    const options = { sessionId: cdpSessionId || undefined, timeoutMs: this.netBodyTimeoutMs };
    let text = typeof info?.postData === 'string' ? info.postData : '';
    if (text === '') {
      try {
        const post = await cdp.send('Network.getRequestPostData', { requestId }, options);
        text = post && typeof post.postData === 'string' ? post.postData : '';
      } catch {
        // A bodyless POST is legitimate: leave the existing/empty record rather than guessing.
        return;
      }
    }
    if (text === '') return;
    const contentType = this.net.readHeaders({ targetId, cdpSessionId, requestId, hopId, kind: 'request' })
      ?.headers?.['content-type'] ?? null;
    const sanitized = network.sanitizeBody(text, contentType, { maskRules: this.net.config.maskRules });
    if (sanitized.payloadOmitted && sanitized.kind === 'binary') return;
    this.net.addBody({
      targetId, cdpSessionId, requestId, hopId, kind: 'request',
      state: sanitized.text === '' ? 'empty' : 'captured',
      data: sanitized.text, contentType, redacted: sanitized.redacted, payloadOmitted: false,
    });
  }

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
    //
    // Order matters: CDP is asked FIRST for body-capable methods, because the `info` bag carried by
    // `loadingFinished` is not always the one populated at `requestWillBeSent` (measured: a POST
    // whose postData was visible in the request map was still recorded as `empty`). CDP has the
    // data either way; `info.postData` is the fallback, never the gate.
    if (config.captureBodies) {
      const noBodyMethod = method === 'GET' || method === 'HEAD';
      const storeEmptyRequest = () => {
        this.net.addBody({ targetId, cdpSessionId, requestId, hopId, kind: 'request', state: 'empty', contentType: requestType });
        out.requestBytes = 0;
      };
      if (noBodyMethod) {
        storeEmptyRequest();
      } else {
        let text = typeof info.postData === 'string' ? info.postData : '';
        if (text === '') {
          try {
            const post = await cdp.send('Network.getRequestPostData', { requestId }, options);
            text = post && typeof post.postData === 'string' ? post.postData : '';
          } catch (error) {
            // A bodyless POST legitimately fails here: record the classified reason, never guess.
            this.net.addBody({
              targetId, cdpSessionId, requestId, hopId, kind: 'request', state: 'unavailable',
              reasonCode: network.classifyBodyFailure(error),
              reasonDetail: error && error.message !== undefined ? error.message : String(error || ''),
            });
            out.requestBytes = null;
            text = null;
          }
        }
        if (text !== null) {
          if (text === '') {
            storeEmptyRequest();
          } else {
            const stored = storeBody('request', text, requestType);
            out.requestBytes = stored ? stored.bytes : null;
          }
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
          // TOOL-P1-04: same contract as the request-body catch above (enum code + redacted detail).
          this.net.addBody({
            targetId, cdpSessionId, requestId, hopId, kind: 'response', state: 'unavailable',
            reasonCode: network.classifyBodyFailure(error),
            reasonDetail: error && error.message !== undefined ? error.message : String(error || ''),
          });
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
      canvasX: view.canvasX,
      canvasY: view.canvasY,
      width: view.width,
      height: view.height,
      scale: view.scale,
      source: view.source,
      revision: view.revision,
    };
  }

  /** Content box as measured by the last real readback; null values when nothing was observed. */
  contentProjection() {
    const observed = this.observed;
    return {
      width: observed && Number.isFinite(observed.contentWidth) ? observed.contentWidth : null,
      height: observed && Number.isFinite(observed.contentHeight) ? observed.contentHeight : null,
    };
  }

  /**
   * `ui.canvas` (docs/viewport-control.md): the viewport origin on the canvas plus the derived
   * residual O = C - S. Safe numbers only; blank is the documented compositing colour and never a
   * page fact (the blank area does not exist in the DOM).
   */
  canvasProjection() {
    const view = this.view;
    const content = this.contentProjection();
    return {
      version: 1,
      space: 'canvas-css-px',
      x: view.canvasX,
      y: view.canvasY,
      offsetX: view.canvasX - view.x,
      offsetY: view.canvasY - view.y,
      contentWidth: content.width,
      contentHeight: content.height,
      blank: 'white',
    };
  }

  /**
   * Derived canvas residual O = C - S from the authoritative view (docs/viewport-control.md).
   * Never stored separately; capture/T3 use it to decide whether a page-frame composite is needed.
   */
  canvasOffset() {
    return { x: this.view.canvasX - this.view.x, y: this.view.canvasY - this.view.y };
  }

  /** Whether the canvas framing differs from the page frame (any axis) beyond float noise. */
  canvasSpaceActive() {
    const offset = this.canvasOffset();
    return Math.abs(offset.x) > 1e-6 || Math.abs(offset.y) > 1e-6;
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

  /** Freshness/identity companions for the cached view (docs/viewport-control.md). */
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
      canvas: this.canvasProjection(),
      content: this.contentProjection(),
      observed: this.observedProjection(),
      viewMeta: this.viewMeta(),
    };
  }

  /* ---- shared view: observation ------------------------------------------------------------ */

  /**
   * One real `Page.getLayoutMetrics` read (plus the page DPR as evidence).
   *
   * `cssLayoutViewport.pageX/pageY` is the authoritative document scroll position and
   * `clientWidth/clientHeight` the CSS viewport size (docs/viewport-control.md). A Chromium
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
   * Bounded stable readback (docs/viewport-control.md step 5): two frames, then at most
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
   *
   * Canvas coordinate rule (docs/viewport-control.md): O = C - S is preserved unless the caller
   * supplies the offset it just applied. With `offset` the residual is authoritative (a canvas patch
   * computes it from the requested C and the target S), otherwise the old O is kept and
   * `C = S_observed + O` — that is what makes a pure x/y set or a resize keep the canvas framing.
   */
  #commitViewObservation(observed, { source = null, originId, scale = null, offset = null } = {}) {
    const view = this.view;
    const previousX = view.x;
    const previousY = view.y;
    let changed = false;
    if (observed) {
      this.observed = observed;
      for (const key of ['x', 'y', 'width', 'height']) {
        if (!Number.isFinite(observed[key])) continue;
        if (Math.abs(observed[key] - view[key]) > 1e-6) { view[key] = observed[key]; changed = true; }
      }
    }
    const offsetX = offset && Number.isFinite(offset.x) ? offset.x : view.canvasX - previousX;
    const offsetY = offset && Number.isFinite(offset.y) ? offset.y : view.canvasY - previousY;
    if (Number.isFinite(view.x)) {
      const canvasX = view.x + offsetX;
      if (Math.abs(canvasX - view.canvasX) > 1e-6) { view.canvasX = canvasX; changed = true; }
    }
    if (Number.isFinite(view.y)) {
      const canvasY = view.y + offsetY;
      if (Math.abs(canvasY - view.canvasY) > 1e-6) { view.canvasY = canvasY; changed = true; }
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
   * Coalesced, single-flight, throttled view observation (docs/viewport-control.md).
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
   * bumps the revision. The canvas residual O is preserved: `C = S_new + O` (docs/viewport-control.md
   * §3, invariant 4) — the page may scroll itself without the canvas framing moving.
   */
  #commitObservedPosition(observed) {
    if (!observed) return false;
    this.observed = observed;
    const view = this.view;
    const offsetX = view.canvasX - view.x;
    const offsetY = view.canvasY - view.y;
    let changed = false;
    for (const key of ['x', 'y']) {
      if (!Number.isFinite(observed[key])) continue;
      if (Math.abs(observed[key] - view[key]) > 1e-6) { view[key] = observed[key]; changed = true; }
    }
    if (Number.isFinite(view.x)) {
      const canvasX = view.x + offsetX;
      if (Math.abs(canvasX - view.canvasX) > 1e-6) { view.canvasX = canvasX; changed = true; }
    }
    if (Number.isFinite(view.y)) {
      const canvasY = view.y + offsetY;
      if (Math.abs(canvasY - view.canvasY) > 1e-6) { view.canvasY = canvasY; changed = true; }
    }
    if (changed) {
      view.source = 'page';
      view.revision += 1;
    }
    return changed;
  }

  /**
   * A committed main-frame navigation / reload starts a new document: the canvas residual is dropped
   * (O=0, docs/viewport-control.md invariant 5). The origin C is anchored to the last measured S,
   * and the coalesced readback that follows moves both to the browser's final scroll position.
   */
  #resetCanvasOnNavigation() {
    const view = this.view;
    let changed = false;
    if (Number.isFinite(view.x) && Math.abs(view.canvasX - view.x) > 1e-6) { view.canvasX = view.x; changed = true; }
    if (Number.isFinite(view.y) && Math.abs(view.canvasY - view.y) > 1e-6) { view.canvasY = view.y; changed = true; }
    if (changed) { view.source = 'page'; view.revision += 1; }
    return changed;
  }

  /* ---- shared view: set -------------------------------------------------------------------- */

  /**
   * Apply one validated view patch **inside** the serial queue (docs/viewport-control.md).
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
    const wantsScroll = patch.x !== undefined || patch.y !== undefined;
    const wantsCanvas = patch.canvasX !== undefined || patch.canvasY !== undefined;
    if (wantsScroll && wantsCanvas) {
      throw new BrowserError('INVALID_ARGUMENT', 'canvasX/canvasY 不能与 x/y 同时给出（画布坐标与文档滚动是两种坐标空间）', {
        fields: ['canvasX', 'canvasY', 'x', 'y'],
      });
    }
    const before = this.viewProjection();
    const requested = { ...patch };
    const targetWidth = patch.width !== undefined ? patch.width : this.view.width;
    const targetHeight = patch.height !== undefined ? patch.height : this.view.height;
    const needsOverride = targetWidth !== this.view.width || targetHeight !== this.view.height;
    const appliedFields = [];
    let overrideApplied = false;
    // Derived residual O = C - S at call time (docs/viewport-control.md). The axis rules:
    //   canvasX/Y given : O = C_requested - S_target (browser may clamp S_target)
    //   only x/y given  : keep O, so C_new = S_target + O_old
    //   neither (resize): keep O, so C_new = S_actual + O_old
    let offsetX = before.canvasX - before.x;
    let offsetY = before.canvasY - before.y;
    /** Offset that was actually dispatched to the browser (used by the partial-apply error path). */
    let appliedOffset = null;
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
      if (wantsCanvas) {
        // Content bounds come from a live read (after any metrics override): S_target = clamp(C,0,max).
        const live = await this.#readViewMetrics(signal);
        const contentWidth = Number.isFinite(live.contentWidth) ? live.contentWidth : targetWidth;
        const contentHeight = Number.isFinite(live.contentHeight) ? live.contentHeight : targetHeight;
        const maxX = Math.max(0, contentWidth - targetWidth);
        const maxY = Math.max(0, contentHeight - targetHeight);
        // A preserved axis keeps O against the live scroll; both axes still get a scroll target so the
        // untouched axis is a no-op instead of an implicit jump.
        const canvasX = patch.canvasX !== undefined ? patch.canvasX : live.x + offsetX;
        const canvasY = patch.canvasY !== undefined ? patch.canvasY : live.y + offsetY;
        const targetX = Math.min(Math.max(canvasX, 0), maxX);
        const targetY = Math.min(Math.max(canvasY, 0), maxY);
        offsetX = canvasX - targetX;
        offsetY = canvasY - targetY;
        await this.#scrollViewTo(targetX, targetY, signal);
        appliedOffset = { x: offsetX, y: offsetY };
        if (patch.canvasX !== undefined) appliedFields.push('canvasX');
        if (patch.canvasY !== undefined) appliedFields.push('canvasY');
      } else if (wantsScroll) {
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
        source, originId,
        scale: patch.scale !== undefined ? patch.scale : null,
        offset: { x: offsetX, y: offsetY },
      });
      const view = this.viewProjection();
      return {
        ok: true,
        requested,
        before,
        view,
        // Additive top-level canvas facts (docs/viewport-control.md step 7): the same numbers as
        // the `view` projection plus the derived offset and measured content box.
        canvasX: view.canvasX,
        canvasY: view.canvasY,
        offset: { x: view.canvasX - view.x, y: view.canvasY - view.y },
        content: this.contentProjection(),
        observed: this.observedProjection(),
        viewMeta: this.viewMeta(),
        applied: true,
        settled,
        clamped: {
          x: requested.x !== undefined && Math.abs(observed.x - requested.x) > 0.01,
          y: requested.y !== undefined && Math.abs(observed.y - requested.y) > 0.01,
          canvasX: requested.canvasX !== undefined && Math.abs(view.canvasX - requested.canvasX) > 0.01,
          canvasY: requested.canvasY !== undefined && Math.abs(view.canvasY - requested.canvasY) > 0.01,
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
        const commitOffset = appliedOffset || { x: this.view.canvasX - this.view.x, y: this.view.canvasY - this.view.y };
        for (const key of ['x', 'y']) {
          if (Number.isFinite(last[key]) && Math.abs(last[key] - this.view[key]) > 1e-6) {
            this.view[key] = last[key];
            changed = true;
          }
        }
        if (Number.isFinite(this.view.x)) {
          const canvasX = this.view.x + commitOffset.x;
          if (Math.abs(canvasX - this.view.canvasX) > 1e-6) { this.view.canvasX = canvasX; changed = true; }
        }
        if (Number.isFinite(this.view.y)) {
          const canvasY = this.view.y + commitOffset.y;
          if (Math.abs(canvasY - this.view.canvasY) > 1e-6) { this.view.canvasY = canvasY; changed = true; }
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
        canvas: this.canvasProjection(),
        observed: this.observedProjection(),
      };
      throw classified;
    }
  }

  /**
   * Legacy `POST /viewport {width,height}` (docs/viewport-control.md): Number/round/clamp to
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

  state(annotations = null) {
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
      // `ui.view` serve the same data (docs/viewport-control.md). `canvas` is the safe
      // canvas-space projection (docs/viewport-control.md).
      view: this.viewProjection(),
      canvas: this.canvasProjection(),
      // Human panel annotations (docs/viewport-control.md): untrusted problem hints the Agent
      // reads through `browser_state`. Pure JSON, no page text, no absolute path; reading it never
      // starts a page and never takes the lease. `uiState()` passes the projection it already
      // computed so the hot /state /frame path builds this document exactly once per request.
      annotations: annotations || this.annotationsDocument(),
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
  uiState({ includeDevtools = false } = {}) {
    this.uiRevision += 1;
    const running = Boolean(this.cdp && !this.cdp.closed);
    const annotations = this.annotationsDocument();
    return {
      ...this.state(annotations),
      ui: {
        version: 1,
        runtimeId: this.runtimeId,
        display: {
          mode: this.host && this.host.display === 'headed' ? 'headed' : 'headless',
          window: this.host && typeof this.host.displayWindow === 'string' ? this.host.displayWindow : 'none',
          hidden: this.host ? this.host.windowHidden === true : false,
        },
        revision: this.uiRevision,
        scope: this.scope,
        address: running ? this.url : '',
        history: { ...(running ? this.history : emptyHistory()) },
        // Shared viewport projection (docs/viewport-control.md): the same `view` the Agent
        // tool reads, plus the observation and its freshness. Additive only.
        view: this.viewProjection(),
        // Canvas-space projection (docs/viewport-control.md): C/O/content/blank for the panel.
        canvas: this.canvasProjection(),
        // P0-D annotations (docs/viewport-control.md): the document the panel publishes to and
        // the navigation token it must echo back. Additive only.
        annotations,
        annotationContext: this.annotationContext(),
        viewMeta: this.viewMeta(),
        observed: this.observedProjection(),
        // Authenticated scoped GUI only: the legacy projection also calls uiState(), so this is
        // opt-in instead of always-present. It carries a loopback port + target id, which must
        // never reach browser_state, a tool value, metrics, logs or an unauthenticated response.
        ...(includeDevtools ? { devtools: this.#devtoolsProjection() } : {}),
        // Workspace-group GUI projection (popup internal tabs): the SAME views list/notices on
        // the primary and every child /state, never on legacy or Agent values.
        ...(includeDevtools && this.registry && typeof this.registry.uiViews === 'function'
          ? this.registry.uiViews(this) : {}),
      },
    };
  }

  /**
   * DevTools popup projection (docs/internal/devtools-popup.md §3).
   *
   * Pure synchronous cache read: no ensure/fetch/CDP/target/lease. The URL is only offered when
   * this runtime still owns the live page target in the current host generation; a cold, closing
   * or re-generated host immediately reports unavailable.
   */
  #devtoolsProjection() {
    const unavailable = { available: false, url: null, pageGeneration: null, reason: 'not-running' };
    const host = this.host;
    if (!host || !host.running) return unavailable;
    if (!this.cdp || this.cdp.closed || !this.page) return unavailable;
    const port = Number(host.port);
    if (!Number.isInteger(port) || port <= 0 || port > 65535) return unavailable;
    const targetId = this.page.targetId;
    if (typeof targetId !== 'string' || !/^[A-Za-z0-9_-]{1,128}$/.test(targetId)) return unavailable;
    const owned = host.ownedTargets.get(targetId);
    if (!owned || owned.runtime !== this || owned.generation !== this.page.generation) return unavailable;
    if (!Number.isInteger(host.generation) || host.generation !== this.page.generation) return unavailable;
    const url = new URL(`http://127.0.0.1:${port}/devtools/inspector.html`);
    // Only the trusted loopback constant, the verified port and this runtime's target id are
    // concatenated; no page URL, query or client-supplied value is forwarded.
    url.searchParams.set('ws', `127.0.0.1:${port}/devtools/page/${targetId}`);
    return { available: true, url: url.toString(), pageGeneration: this.page.generation, reason: null };
  }

  /* -------------------------------------------------------------------------------------------
   * P0-D annotations — Agent-visible human notes (docs/viewport-control.md).
   *
   * One "last accepted" document per Runtime, one write surface (`POST /annotations`, scoped and
   * peer-authenticated only), one navigation token. Nothing here starts a page, takes the lease or
   * writes `lastError`: a refused publish must cost the page nothing.
   * ----------------------------------------------------------------------------------------- */

  /** The navigation token the panel must echo back; created lazily, rotated on document changes. */
  #annotationKey() {
    if (!this.annot.documentKey) this.annot.documentKey = randomUUID();
    return this.annot.documentKey;
  }

  /**
   * Salted 64-hex digest of the current address. The real address (with its token/path) never
   * enters the document, an error body or a log line — only this one-way digest does.
   */
  #annotationAddressDigest() {
    return createHash('sha256')
      .update(this.annot.salt)
      .update('\u0000')
      .update(String(this.url || ''))
      .digest('hex');
  }

  /** Public context for `ui.annotationContext` (the same source the stored document cites). */
  annotationContext() {
    return {
      runtimeId: this.runtimeId,
      pageGeneration: this.pageGeneration(),
      documentEpoch: this.documentEpoch(),
      documentKey: this.#annotationKey(),
      addressDigest: this.#annotationAddressDigest(),
    };
  }

  /**
   * Refresh the human-foreground claim for this runtime (`browser_annotation`).
   *
   * Only the authenticated panel sends the report (it does so on `/state`, `/frame` and `/metrics`
   * for the tab it is actually displaying, and stops as soon as it is hidden or another tab is
   * selected). The Agent cannot raise its own claim through any tool: this method is reachable only
   * from the scoped GUI routes.
   */
  noteGuiForeground(viewId = null) {
    this.annot.guiForegroundAt = Date.now();
    this.annot.guiForegroundView = typeof viewId === 'string' && viewId.length > 0 ? viewId : 'primary';
  }

  /**
   * Is this runtime the tab a human is looking at right now?
   *
   * `active` is a *freshness* answer, never a stored permission: it goes false on its own within
   * `ANNOTATION_FOREGROUND_TTL_MS` when the panel stops reporting (tab switched away, panel closed,
   * DSH tab backgrounded). A dead page is never in the foreground.
   */
  guiForeground() {
    const at = Number(this.annot.guiForegroundAt) || 0;
    const ageMs = at > 0 ? Math.max(0, Date.now() - at) : null;
    return {
      active: this.running && at > 0 && ageMs !== null && ageMs <= ANNOTATION_FOREGROUND_TTL_MS,
      viewId: this.annot.guiForegroundView || null,
      ageMs,
      maxAgeMs: ANNOTATION_FOREGROUND_TTL_MS,
    };
  }

  /** The document's shapes for a read-modify-write, or [] when the document is not this one. */
  annotationCurrentShapes() {
    this.#annotationPrune();
    const document = this.annot.document;
    if (!document || !document.context || document.context.documentKey !== this.annot.documentKey) return [];
    return document.shapes.map((shape) => JSON.parse(JSON.stringify(shape)));
  }

  /** Rotate the navigation token and drop everything stored under the old one (§11.2). */
  #annotationRotate(reason) {
    const hadDocument = this.annot.document !== null;
    this.annot.documentKey = randomUUID();
    this.annot.document = null;
    this.annot.panels.clear();
    this.annot.lastSeenAt = 0;
    this.annot.updatedAt = null;
    this.annot.lastRotateReason = reason;
    if (hadDocument) this.annot.revision += 1;
  }

  /** A dead page can never validate a stored document: drop it the first time we notice. */
  #annotationPrune() {
    if (this.annot.document === null) return;
    if (!this.running) { this.#annotationRotate('not-running'); return; }
    if (this.annot.document.context.documentKey !== this.annot.documentKey) this.#annotationRotate('context-changed');
  }

  /** `stale`/`staleReason` are computed at read time (§11.3): never trusted from a snapshot. */
  #annotationStale(document) {
    if (!this.running) return { stale: true, staleReason: 'not-running' };
    if (!document) return { stale: false, staleReason: null };
    const context = document.context || {};
    if (context.documentKey !== this.annot.documentKey
      || context.pageGeneration !== this.pageGeneration()
      || context.documentEpoch !== this.documentEpoch()) {
      return { stale: true, staleReason: 'context-changed' };
    }
    const seenAt = Math.max(this.annot.lastSeenAt || 0, document.updatedAt || 0);
    if (Date.now() - seenAt > ANNOTATION_LIMITS.staleAfterMs) return { stale: true, staleReason: 'panel-unseen' };
    return { stale: false, staleReason: null };
  }

  /** Safe projection: `browser_state.annotations` and `ui.annotations` are the same JSON. */
  annotationsDocument() {
    this.#annotationPrune();
    const document = this.annot.document;
    const { stale, staleReason } = this.#annotationStale(document);
    return {
      version: ANNOTATION_VERSION,
      space: ANNOTATION_SPACE,
      revision: this.annot.revision,
      updatedAt: document ? document.updatedAt : null,
      source: document ? JSON.parse(JSON.stringify(document.source)) : null,
      context: document ? JSON.parse(JSON.stringify(document.context)) : null,
      view: document ? JSON.parse(JSON.stringify(document.view)) : null,
      shapes: document ? JSON.parse(JSON.stringify(document.shapes)) : [],
      truncated: document ? document.truncated === true : false,
      truncation: document
        ? { ...document.truncation }
        : { droppedShapes: 0, droppedPoints: 0, shortenedTextCodeUnits: 0 },
      stale,
      staleReason,
      // Human-foreground claim (docs/viewport-control.md): `browser_annotation` writes are refused
      // unless `active` is true. Computed at read time, never stored in the document.
      foreground: this.guiForeground(),
    };
  }

  /**
   * `/metrics` heartbeat (docs/viewport-control.md): only a heartbeat naming the current source
   * and the accepted clientRevision (and, when given, the current documentKey) refreshes
   * `lastSeenAt`. It never touches shapes, the Host revision, `lastError`, the view or who may write.
   */
  noteAnnotationHeartbeat(input) {
    const panelId = input && typeof input.annotationPanelId === 'string' ? input.annotationPanelId.toLowerCase() : null;
    if (!panelId) return false;
    const document = this.annot.document;
    if (!document || !document.source) return false;
    if (document.source.panelId !== panelId) return false;
    const clientRevision = input.annotationClientRevision;
    if (clientRevision !== undefined && clientRevision !== null) {
      if (!Number.isSafeInteger(clientRevision) || clientRevision !== document.source.clientRevision) return false;
    }
    const documentKey = input.documentKey;
    if (documentKey !== undefined && documentKey !== null) {
      if (typeof documentKey !== 'string' || documentKey !== this.annot.documentKey) return false;
    }
    this.annot.lastSeenAt = Date.now();
    return true;
  }

  /** The stored document as it will be projected (used for the exact byte budget as well). */
  #annotationBuild(request, shapes, truncation, updatedAt) {
    return {
      version: ANNOTATION_VERSION,
      space: ANNOTATION_SPACE,
      revision: this.annot.revision + 1,
      updatedAt,
      // A panel publish cites the panel; `browser_annotation` passes its own source so a document
      // written by the Agent never claims a human drew it (`trusted` stays false either way).
      source: request.source
        ? { ...request.source }
        : {
          kind: 'human-panel',
          panelId: request.panelId,
          surface: request.surface,
          clientRevision: request.clientRevision,
          trusted: false,
        },
      context: this.annotationContext(),
      view: { ...request.view },
      shapes: shapes.map((shape) => JSON.parse(JSON.stringify(shape))),
      truncated: truncation.droppedShapes > 0 || truncation.droppedPoints > 0 || truncation.shortenedTextCodeUnits > 0,
      truncation: { ...truncation },
    };
  }

  /**
   * Accept one publish (already structurally validated by `normalizeAnnotationPublish`).
   *
   * Order matters: a rejected request must leave the document, the revision, the panel watermark
   * and `lastError` exactly as they were.
   */
  acceptAnnotations(request) {
    if (!this.running) throw annotationInvalid('runtime', 'annotation-runtime-not-running');
    if (request.context.runtimeId !== this.runtimeId) {
      throw new BrowserError('SCOPE_INVALID', '标注发布指向了另一个运行时', {
        field: 'context.runtimeId', reason: 'annotation-runtime-mismatch', limits: annotationLimits(),
      });
    }
    const documentKey = this.#annotationKey();
    const generation = this.pageGeneration();
    const epoch = this.documentEpoch();
    if (request.context.documentKey !== documentKey
      || request.context.pageGeneration !== generation
      || request.context.documentEpoch !== epoch) {
      throw annotationStale();
    }
    const ack = (accepted, ignored, clientRevision) => ({
      accepted, ignored, clientRevision, annotations: this.annotationsDocument(),
    });
    const panel = this.annot.panels.get(request.panelId) || null;
    const digest = annotationDigest(request);
    if (panel) {
      // De-duplicate per panel: a late (lower) revision is acknowledged but never overwrites.
      if (request.clientRevision < panel.clientRevision) return ack(false, true, panel.clientRevision);
      if (request.clientRevision === panel.clientRevision) {
        if (panel.digest !== digest) throw annotationInvalid('clientRevision', 'annotation-client-revision-conflict');
        return ack(true, true, request.clientRevision);
      }
    } else if (this.annot.panels.size >= ANNOTATION_LIMITS.maxPanels) {
      throw annotationInvalid('panelId', 'annotation-source-limit');
    }
    const current = this.annot.document;
    if (request.release && current && current.source && current.source.panelId !== request.panelId) {
      // A release may only clear the document its own panel published — never another panel's notes.
      return ack(false, true, request.clientRevision);
    }
    let shapes;
    let truncation;
    if (request.release) {
      shapes = [];
      truncation = { droppedShapes: 0, droppedPoints: 0, shortenedTextCodeUnits: 0 };
    } else {
      const limited = applyAnnotationLimits(request.shapes, request.truncation, request.shortenedText);
      shapes = limited.shapes;
      truncation = limited.truncation;
    }
    const updatedAt = Date.now();
    let document = this.#annotationBuild(request, shapes, truncation, updatedAt);
    // Byte budget: drop the oldest whole shapes until the serialized document fits (never a
    // half-serialized shape, never a truncated coordinate object).
    while (Buffer.byteLength(JSON.stringify(document), 'utf8') > ANNOTATION_LIMITS.maxDocumentBytes && shapes.length > 0) {
      shapes = shapes.slice(1);
      truncation = { ...truncation, droppedShapes: truncation.droppedShapes + 1 };
      document = this.#annotationBuild(request, shapes, truncation, updatedAt);
    }
    this.annot.revision += 1;
    document.revision = this.annot.revision;
    this.annot.document = document;
    this.annot.updatedAt = updatedAt;
    this.annot.lastSeenAt = updatedAt;
    this.annot.panels.set(request.panelId, { clientRevision: request.clientRevision, digest });
    return ack(true, false, request.clientRevision);
  }

  /** The annotation document's `view` snapshot for an Agent write (canvas CSS px space). */
  #annotationAgentView() {
    const view = this.view;
    const content = this.contentProjection();
    return {
      canvasX: view.canvasX,
      canvasY: view.canvasY,
      x: view.x,
      y: view.y,
      width: view.width,
      height: view.height,
      scale: view.scale,
      contentWidth: content.width,
      contentHeight: content.height,
      viewRevision: view.revision,
      frameEpoch: this.frames && Number.isFinite(this.frames.epoch) ? this.frames.epoch : null,
    };
  }

  /**
   * `browser_annotation` — the Agent's half of the same document (docs/viewport-control.md).
   *
   * Read-modify-write on ONE shape list: a human note is never overwritten by a draw, and an Agent
   * note survives the human's next edit because the panel hydrates this document before it
   * publishes its own. Every refusal happens before any state is touched, and nothing here starts a
   * page, takes the page lease, dispatches CDP or writes page `lastError`.
   *
   * @param {{action:string, specs:ReadonlyArray<object>, ids:ReadonlyArray<string>,
   *   point:{x:number,y:number,radius:number}|null, expectRevision:number|null}} call
   *   Output of `normalizeAgentAnnotationCall` (already structurally validated).
   * @param {{sessionId?:string|null}} [options] Caller identity for the document's `source`.
   */
  agentAnnotation(call, options = {}) {
    // `read` answers on a cold runtime too (the document is simply empty / stale=not-running);
    // only a *write* needs a page, because only a running page has a panel showing it.
    if (call.action !== 'read' && !this.running) {
      throw annotationInvalid('runtime', 'annotation-runtime-not-running');
    }
    const foreground = this.guiForeground();
    if (call.action !== 'read' && !foreground.active) {
      // The whole point of an Agent note is that a human sees it: drawing on a tab nobody displays
      // would be an invisible write. Zero writes, and the caller is told what has to change.
      throw new BrowserError(
        'ANNOTATION_NOT_FOREGROUND',
        '标注只能画在人类当前选中的标签页上：请在调试视图里选中该标签页并保持可见后重试（本次零写入）',
        {
          reason: 'annotation-not-foreground',
          viewId: foreground.viewId,
          ageMs: foreground.ageMs,
          maxAgeMs: foreground.maxAgeMs,
        },
      );
    }
    const current = this.annotationCurrentShapes();
    if (call.expectRevision !== null && call.expectRevision !== this.annot.revision) {
      throw new BrowserError('ANNOTATION_REVISION_CONFLICT', '标注文档 revision 已变化：本次零写入，请先读取最新文档', {
        reason: 'annotation-revision-conflict',
        expectedRevision: call.expectRevision,
        currentRevision: this.annot.revision,
      });
    }
    if (call.action === 'read') {
      return { ok: true, action: 'read', removed: [], ...this.annotationsDocument() };
    }
    let shapes = current;
    const removed = [];
    let shortenedText = 0;
    if (call.action === 'draw') {
      const allocateId = annotationAgentIdFactory(current, call.specs);
      const seenIds = new Set(current.map((shape) => shape.id));
      const added = [];
      for (let index = 0; index < call.specs.length; index += 1) {
        const result = normalizeAgentAnnotationShape(call.specs[index], `shapes[${index}]`, allocateId, seenIds);
        added.push(result.shape);
        shortenedText += result.shortenedText;
      }
      shapes = current.concat(added);
    } else if (call.action === 'erase') {
      const ids = new Set(call.ids);
      shapes = current.filter((shape) => {
        if (ids.has(shape.id)) { removed.push(shape.id); return false; }
        if (call.point && annotationAgentHit(shape, call.point, call.point.radius)) { removed.push(shape.id); return false; }
        return true;
      });
    } else {
      for (const shape of current) removed.push(shape.id);
      shapes = [];
    }
    const limited = applyAnnotationLimits(
      shapes,
      { droppedShapes: 0, droppedPoints: 0, shortenedTextCodeUnits: 0 },
      shortenedText,
    );
    const updatedAt = Date.now();
    const request = {
      // No panel watermark is consumed: an Agent write must never satisfy a stale panel revision.
      panelId: null,
      surface: 'main',
      clientRevision: 0,
      view: this.#annotationAgentView(),
      source: {
        kind: 'agent-tool',
        tool: 'browser_annotation',
        agentSessionId: options.sessionId ? String(options.sessionId) : null,
        surface: 'main',
        trusted: false,
      },
    };
    let finalShapes = limited.shapes;
    let truncation = limited.truncation;
    let document = this.#annotationBuild(request, finalShapes, truncation, updatedAt);
    // Same byte budget as a panel publish: drop the oldest whole shapes, never a half shape.
    while (Buffer.byteLength(JSON.stringify(document), 'utf8') > ANNOTATION_LIMITS.maxDocumentBytes
      && finalShapes.length > 0) {
      finalShapes = finalShapes.slice(1);
      truncation = { ...truncation, droppedShapes: truncation.droppedShapes + 1 };
      document = this.#annotationBuild(request, finalShapes, truncation, updatedAt);
    }
    this.annot.revision += 1;
    document.revision = this.annot.revision;
    this.annot.document = document;
    this.annot.updatedAt = updatedAt;
    this.annot.lastSeenAt = updatedAt;
    return { ok: true, action: call.action, removed, ...this.annotationsDocument() };
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
      // Capture-time top-level scroll (docs/viewport-control.md): the client needs it to place
      // the frame at the right canvas position; 0 is a legal value.
      scrollX: latest.scrollX,
      scrollY: latest.scrollY,
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
    // Page audio counters (docs/web/debug-panel.md): format + counts only, never PCM payload.
    const audio = (() => {
      try { return this.audio.metrics(); } catch { return null; }
    })();
    const host = {
      ...this.frames.metrics(),
      ackFailures: this.ackFailures,
      audio,
      push,
      cleanupError: this.cleanupError || null,
    };    if (push) {
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
    // FR-01 scope gate: the Agent's own navigation is *exploratory* (passive) — inside the
    // allowlist it is exactly what passive mode permits; the check still counts against the
    // budget and refuses out-of-scope origins/paths with 0 side effects. An unconfigured scope
    // passes through (FR-12: security modules load on demand; plain GUI testing is unaffected).
    this.#scopeCheckDispatch(target, { kind: 'navigate', active: false });
    try {
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
      // FR-01 scope gate on the *landed* URL: a redirect chain is checked hop by hop (INF-02) —
      // the final committed URL must still be inside the scope, else the same about:blank bail-out.
      try {
        this.#scopeCheckDispatch(this.url, { kind: 'redirect-hop' });
      } catch (error) {
        await this.send('Page.navigate', { url: 'about:blank' }, signal);
        throw error;
      }
      await historyRead;
      this.clearError();
      return { url: redactUrl(this.url) };
    } finally {
      // The dispatch started above is complete regardless of outcome: the inFlight counter must
      // never leak, or the concurrency budget would strangle the session after a failed hop.
      this.#scopeCompleteDispatch();
    }
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

  /** Drop the held-key table and the virtual cursor (document replaced or page closed). */
  resetInputState() {
    this.inputState.keys.clear();
    this.inputState.cursor = null;
  }

  /** Modifier bits (CDP Alt=1/Ctrl=2/Meta=4/Shift=8) of every key this page holds down. */
  #heldModifierBits() {
    let bits = 0;
    for (const modifier of this.inputState.keys.values()) bits |= modifier;
    return bits;
  }

  /**
   * Dispatch input events through the held-key state machine (docs/tools.md `browser_input`).
   *
   * Three things a real keyboard/mouse gives a page for free, and a stream of independent CDP
   * dispatches does not:
   *   1. **modifier synthesis** — while Shift is down, every later key/mouse/wheel event carries
   *      `shiftKey:true`. The page's own `keydown` bookkeeping is not enough: `e.shiftKey` comes
   *      from the browser, not from the page's listener.
   *   2. **relative motion** — `deltaX/deltaY` advance a virtual cursor, so pointer-lock style
   *      "move by delta" callers never have to know the absolute position.
   *   3. **a release path** — `keyUp` clears the entry, and a replaced document clears everything
   *      (a stale held key would otherwise keep marking events as Shift-pressed forever).
   *
   * @returns {{applied:number, modifiers:number, held:string[], cursor:{x:number,y:number}|null}}
   */
  async input(events, signal) {
    if (!Array.isArray(events) || events.some((event) => !event || !['mouse', 'wheel', 'key', 'text'].includes(event.kind))) {
      throw new BrowserError('INVALID_ARGUMENT', '输入事件 kind 无效');
    }
    if (events.length > INPUT_EVENT_LIMIT) {
      throw new BrowserError('INVALID_ARGUMENT', `单批输入事件过多：${events.length} > ${INPUT_EVENT_LIMIT}`, { maxItems: INPUT_EVENT_LIMIT });
    }
    // Normalize/validate the whole batch first: a bad modifiers value must not start Chromium.
    const prepared = events.map((event) => ({ event, prepared: prepareInputEvent(event) }));
    await this.ensure(signal);
    const viewport = this.viewport;
    const epoch = this.documentEpoch();
    const initialKeys = new Map(this.inputState.keys);
    const initialCursor = this.inputState.cursor;
    const restoreInputState = () => {
      this.inputState.keys = new Map(initialKeys);
      this.inputState.cursor = initialCursor;
    };
    const dispatchAll = async () => {
      for (const item of prepared) {
        const { event } = item;
        const params = { ...item.prepared.params };
        if (item.prepared.kind === 'key') {
          const type = String(params.type || '').toLowerCase();
          const identity = inputKeyIdentity(event);
          const modifier = inputKeyModifier(event);
          const synthesize = event.synthesizeModifiers !== false;
          // A keyUp still reports the modifier it is releasing; a press reports the state *before*
          // it lands (same order a real OS produces).
          params.modifiers = (Number(params.modifiers) || 0) | (synthesize ? this.#heldModifierBits() : 0);
          if (identity) {
            if (inputPressesKey(type)) this.inputState.keys.set(identity, modifier);
            else if (type === 'keyup') this.inputState.keys.delete(identity);
          }
        } else if (item.prepared.kind === 'mouse' || item.prepared.kind === 'wheel') {
          if (event.synthesizeModifiers !== false) {
            params.modifiers = (Number(params.modifiers) || 0) | this.#heldModifierBits();
          }
          if (item.prepared.kind === 'mouse') {
            const hasDelta = Number.isFinite(event.deltaX) || Number.isFinite(event.deltaY);
            if (hasDelta) {
              if (!params.type) params.type = 'mouseMoved';
              const base = this.inputState.cursor
                || { x: Math.round(viewport.width / 2), y: Math.round(viewport.height / 2) };
              const next = {
                x: Math.min(Math.max(0, base.x + (Number.isFinite(event.deltaX) ? event.deltaX : 0)), Math.max(0, viewport.width - 1)),
                y: Math.min(Math.max(0, base.y + (Number.isFinite(event.deltaY) ? event.deltaY : 0)), Math.max(0, viewport.height - 1)),
              };
              params.x = next.x;
              params.y = next.y;
              this.inputState.cursor = { ...next };
              if (params.type === 'mouseMoved' && !Number.isFinite(event.buttons)) params.buttons = 0;
            } else if (Number.isFinite(params.x) && Number.isFinite(params.y)) {
              this.inputState.cursor = { x: params.x, y: params.y };
            }
          }
        }
        if (item.prepared.kind === 'mouse' || item.prepared.kind === 'wheel') {
          await this.send('Input.dispatchMouseEvent', params, signal);
        } else if (item.prepared.kind === 'key') {
          await this.send('Input.dispatchKeyEvent', params, signal);
        } else if (item.prepared.kind === 'text') {
          await this.send('Input.insertText', params, signal);
        }
      }
    };
    // A batch that carries a press/release, a key or a wheel is something the page must observe;
    // a text-only batch is not (insertText without focus legitimately produces no DOM event), so
    // only the former is verified (docs/web/input-delivery.md).
    const mustBeObserved = events.some((event) => {
      if (event.kind === 'wheel') return true;
      if (event.kind === 'key') return true;
      if (event.kind !== 'mouse') return false;
      const type = String(event.type || '').toLowerCase();
      return type !== '' && type !== 'mousemoved';
    });
    // What the page must have observed for *this* batch: the same press/release rule when the batch
    // carries a button gesture, a key pair for key batches, and at least one event otherwise.
    const requiredGroups = (() => {
      // CDP dispatch types -> the DOM events the page must observe for each of them.
      const DOM_EVENTS = {
        mousepressed: ['mousedown', 'pointerdown'],
        mousereleased: ['mouseup', 'pointerup'],
        mousemoved: ['mousemove', 'pointermove'],
        mousewheel: ['wheel'],
        keydown: ['keydown'],
        rawkeydown: ['keydown'],
        keyup: ['keyup'],
      };
      const groups = [];
      for (const item of prepared) {
        const type = String(item.prepared.params.type || '').toLowerCase();
        const group = DOM_EVENTS[type];
        if (!group) continue;
        if (!groups.some((existing) => existing.join('|') === group.join('|'))) groups.push(group);
      }
      if (!groups.length) groups.push(['mousemove', 'wheel', 'pointermove', 'scroll', 'keydown', 'keyup', 'input']);
      return groups;
    })();
    // Text and char events can have effects without matching the gesture's delivery probe.
    const canRetry = prepared.every(({ prepared: { kind, params } }) => kind !== 'text' && params.type !== 'char');
    const canRecycle = this.host?.display === 'headless' && !events.some((event) => event.kind === 'wheel');
    let delivery = { verified: false, delivered: null, attempts: 0, seen: [] };
    if (mustBeObserved && await this.#installInputProbe(signal)) {
      for (let attempt = 1; attempt <= 2; attempt += 1) {
        await dispatchAll();
        delivery.attempts = attempt;
        const probe = await this.#readInputProbeSettled(requiredGroups, signal);
        if (!probe?.present) {
          delivery = { verified: false, delivered: null, attempts: attempt, seen: [] };
          break;
        }
        const verdict = inputDeliveryVerdict(probe.seen, requiredGroups);
        const delivered = verdict.delivered;
        delivery = { verified: true, delivered, attempts: attempt, seen: probe.seen.slice(0, 12), missing: verdict.missing };
        if (delivered || probe.seen.length || !canRetry || attempt === 2) break;
        await this.activate(signal).catch(() => false);
        if (this.documentEpoch() !== epoch || !(await this.#installInputProbe(signal)) || this.documentEpoch() !== epoch) break;
        restoreInputState();
      }
      if (canRecycle && this.documentEpoch() === epoch && delivery.attempts === 2 && delivery.delivered === false && delivery.seen.length === 0) {
        const healed = await this.#redispatchAfterRecycle(requiredGroups, dispatchAll, signal);
        if (healed) {
          delivery = { verified: true, ...healed, attempts: delivery.attempts + 1, recovery: 'document-recycled' };
        }
      }
      if (delivery.delivered === false) {
        throw new BrowserError('INPUT_NOT_DELIVERED',
          '输入事件未完整送达页面：页面未观察到全部预期事件',
          {
            applied: events.length,
            attempts: delivery.attempts,
            seen: delivery.seen,
            missing: delivery.missing,
            hint: (delivery.recovery === 'document-recycled'
              ? '自动重建文档后仍未确认输入完整送达，请检查页面状态。'
              : '页面未确认收到完整输入，请检查当前标签的状态。'),
          });
      }
    } else {
      await dispatchAll();
      delivery.attempts = events.length > 0 ? 1 : 0;
    }
    // A wheel/click/drag can move the page (momentum/smooth scroll/snap): two coalesced settling
    // samples, 50ms and 250ms after the dispatch (docs/viewport-control.md).
    this.refreshViewObservationSoon({ delayMs: 50 });
    this.refreshViewObservationSoon({ delayMs: 250 });
    return {
      applied: events.length,
      delivery,
      modifiers: this.#heldModifierBits(),
      held: [...this.inputState.keys.keys()],
      cursor: this.inputState.cursor ? { ...this.inputState.cursor } : null,
    };
  }

  /**
   * Panel-side `<select>` write (`POST /select`).
   *
   * One DOM write through the page: the native `selectedIndex` setter plus `input`/`change`.
   * Bound requests validate the document and resolve the original node before writing; compatibility
   * requests may use a selector or focus. The write stays in the serial queue; the guards in the HTTP route
   * (same order as `/input`) and complete before this method is reached.
   */
  async selectValue(request, signal) {
    await this.ensure(signal);
    let answer;
    if (request.target) {
      const stale = () => new BrowserError('INVALID_ARGUMENT', '下拉目标已变化，请重新打开', { reason: 'stale-target' });
      const tree = await this.send('Page.getFrameTree', {}, signal);
      // A bound `<select>` may live in a same-process child frame: validate the target document
      // against the whole frame tree, not just the root frame.
      if (!frameTreeHasLoaderId(tree && tree.frameTree, request.target.loaderId)) throw stale();
      let objectId;
      try {
        const resolved = await this.send('DOM.resolveNode', { backendNodeId: request.target.backendNodeId }, signal);
        objectId = resolved?.object?.objectId;
      } catch (error) {
        if (['ABORTED', 'CDP_TIMEOUT', 'CDP_DISCONNECTED'].includes(error?.code)) throw error;
        throw stale();
      }
      if (!objectId) throw stale();
      try {
        answer = await this.send('Runtime.callFunctionOn', {
          objectId,
          functionDeclaration: `function () { return ${selectWriteExpression(request, { objectBound: true })}; }`,
          returnByValue: true,
          userGesture: true,
        }, signal);
      } finally {
        try { await this.send('Runtime.releaseObject', { objectId }, signal); } catch { /* best effort */ }
      }
    } else {
      answer = await this.send('Runtime.evaluate', {
        expression: selectWriteExpression(request),
        returnByValue: true,
        awaitPromise: false,
        userGesture: true,
      }, signal);
    }
    if (answer && answer.exceptionDetails) {
      const details = answer.exceptionDetails;
      const description = details.exception ? details.exception.description : details.text;
      throw new BrowserError('EVAL_ERROR', String(description || '<select> 写入失败'));
    }
    const classified = classifySelectWrite(answer && answer.result ? answer.result.value : null);
    if (!classified.ok) throw new BrowserError(classified.code, classified.message, classified.details);
    return classified;
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

  /**
   * Panel screenshot route (`POST /screenshot`).
   *
   * Old call shape (no arguments) is byte-identical to the historical behaviour: one raw
   * `Page.captureScreenshot` of the live page viewport, no clip, no re-encoding.
   *
   * `screenshot({canvas:true})` is the P0-C v2 seed route (docs/viewport-control.md): it goes
   * through `capture({scale:1})`, so O = 0 still dispatches exactly one raw CDP PNG and O ≠ 0
   * returns the white-composited canvas viewport. The reply adds a safe `view` projection and the
   * capture provenance (canvas/composite/contentRect/request/scroll) so a client can bind a seed
   * frame to the canvas ratchet. No page text or filesystem path is ever included.
   */
  async screenshot(options = {}, signal) {
    const canvas = Boolean(options && typeof options === 'object' && options.canvas === true);
    if (!canvas) {
      await this.ensure(signal);
      const capturedAt = Date.now();
      const shot = await this.send('Page.captureScreenshot', { format: 'png' }, signal);
      return { base64: shot.data, viewport: this.viewport, capturedAt };
    }
    const shot = await this.capture({ scale: 1, scaleSource: 'explicit' }, signal);
    const capture = shot.capture;
    return {
      base64: shot.base64,
      // Default canvas capture covers [C,C+W)×[C,C+H); its output is exactly W×H.
      viewport: { width: capture.region.width, height: capture.region.height },
      capturedAt: capture.capturedAt,
      view: this.viewProjection(),
      capture: {
        viewRevision: capture.viewRevision,
        request: capture.request,
        canvas: capture.canvas,
        contentRect: capture.contentRect,
        composite: capture.composite,
        scroll: capture.scroll,
        viewport: capture.viewport,
        region: capture.region,
        effectiveScale: capture.effectiveScale,
        deviceScaleFactor: capture.deviceScaleFactor,
        pageDevicePixelRatio: capture.pageDevicePixelRatio,
      },
    };
  }

  /**
   * P0 capture: one `Page.captureScreenshot` clip in canvas CSS space (O=0 equals document).
   *
   * Geometry (`Page.getLayoutMetrics`):
   *   cssLayoutViewport.pageX/pageY  = document CSS offset of the visible viewport (scroll)
   *   cssLayoutViewport.clientWidth/Height = viewport size in CSS px
   * A `region` is given in canvas CSS space (O=0 equals document), so a region outside the current scroll
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
  async capture({ scale = 1, region, scaleSource = 'explicit', includeAnnotations = false } = {}, signal) {
    const capturedAt = Date.now();
    // The resolved density source travels with the capture so evidence can say whether the caller
    // asked for this scale or the shared view.scale supplied it (docs/viewport-control.md).
    const resolvedScaleSource = scaleSource === 'view' ? 'view' : 'explicit';
    const viewRevisionAtCapture = this.view.revision;
    await this.ensure(signal);
    // Freeze the accepted panel document once, before sampling page pixels. Mid-capture edits
    // cannot mix revisions, and a navigation during either stage fails closed.
    const annotationDocument = includeAnnotations ? this.annotationsDocument() : null;
    const annotationContext = includeAnnotations ? this.annotationContext() : null;
    const finish = shot => includeAnnotations
      ? this.compositeCaptureAnnotations(shot, annotationDocument, annotationContext, signal) : shot;
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
    const contentSize = (layout && layout.cssContentSize) || {};
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
    const content = {
      width: Number.isFinite(contentSize.width) ? contentSize.width : viewport.width,
      height: Number.isFinite(contentSize.height) ? contentSize.height : viewport.height,
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

    // Canvas framing (docs/viewport-control.md): O = C - S is derived from the authority view,
    // S is the live measured scroll. The canvas coordinates equal document coordinates (content is
    // anchored at (0,0)), so a canvas rect can be intersected with the content box and captured by
    // CDP clip as long as it is non-negative.
    const offset = this.canvasOffset();
    const composite = Math.abs(offset.x) > 1e-6 || Math.abs(offset.y) > 1e-6;
    const canvasOrigin = { x: scroll.x + offset.x, y: scroll.y + offset.y };
    const rect = region
      ? { x: region.x, y: region.y, width: region.width, height: region.height }
      : { x: canvasOrigin.x, y: canvasOrigin.y, width: viewport.width, height: viewport.height };
    const contentRect = intersectRects(rect, { x: 0, y: 0, width: content.width, height: content.height });
    const canvasEvidence = {
      version: 1,
      space: 'canvas-css-px',
      x: canvasOrigin.x,
      y: canvasOrigin.y,
      scrollX: scroll.x,
      scrollY: scroll.y,
      offsetX: offset.x,
      offsetY: offset.y,
      contentWidth: content.width,
      contentHeight: content.height,
      blank: '#ffffff',
      composite,
      source: 'cdp-page-capture-screenshot',
    };

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

    const baseCapture = {
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
      // Additive request provenance (same shape the tool evidence uses): the canvas space is the
      // default capture space; O = 0 keeps the historical document-css-px coordinate space.
      request: {
        scale,
        scaleSource: resolvedScaleSource,
        viewRevision: viewRevisionAtCapture,
        region: region ? { x: region.x, y: region.y, width: region.width, height: region.height } : null,
        space: 'canvas-css-px',
        coordinateSpace: composite ? 'canvas-css-px' : 'document-css-px',
        out: null,
        persist: false,
      },
      canvas: canvasEvidence,
      composite,
      contentRect,
      capturedAt,
    };

    // O = 0 keeps the historical single-CDP-PNG path byte-for-byte (no re-encoding).
    if (!composite) {
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
      return finish({
        base64: shot.data,
        pngBytes,
        capture: { ...baseCapture, pageCapture: null },
      });
    }

    // O ≠ 0 must be composited (docs/viewport-control.md + the 2026-11-02 negative-clip spike):
    // capture the page pixels of the content intersection, then paste them into a white canvas
    // viewport at -O and let the output size be the final canvas size (16M budget applies to it).
    let pageCapture = null;
    let pageImage = null;
    if (contentRect.width > 0 && contentRect.height > 0) {
      let pageShot;
      try {
        pageShot = await this.send('Page.captureScreenshot', {
          format: 'png',
          fromSurface: true,
          captureBeyondViewport: true,
          optimizeForSpeed: false,
          clip: { x: contentRect.x, y: contentRect.y, width: contentRect.width, height: contentRect.height, scale: effectiveScale },
        }, signal);
      } catch (error) {
        throw this.#captureError(error, 'captureScreenshot');
      }
      if (!pageShot || typeof pageShot.data !== 'string' || pageShot.data.length === 0) {
        throw new BrowserError('CAPTURE_FAILED', '合成截图没有返回页面 PNG 数据', {
          phase: 'capturePage', reason: 'empty-data', clip: contentRect,
        });
      }
      pageImage = Buffer.from(pageShot.data, 'base64');
      if (pageImage.length === 0) {
        throw new BrowserError('CAPTURE_FAILED', '合成截图的 base64 数据无法解码', {
          phase: 'capturePage', reason: 'empty-bytes', clip: contentRect,
        });
      }
      const pagePng = inspectPng(pageImage, { checkCrc: true });
      if (!pagePng.ok) {
        throw new BrowserError('INVALID_PNG', '合成用的页面截图不是结构完整的 PNG（不交付坏图）', {
          phase: 'capturePage', reason: pagePng.message, clip: contentRect,
        });
      }
      pageCapture = {
        clip: { ...contentRect },
        width: pagePng.width,
        height: pagePng.height,
        bytes: pageImage.length,
        format: 'png',
      };
    }
    const decodedPage = pageImage ? decodePng(pageImage) : null;
    if (pageImage && (!decodedPage || decodedPage.ok !== true)) {
      throw new BrowserError('CAPTURE_FAILED', '合成用的页面截图无法解码为像素', {
        phase: 'composePage', reason: decodedPage && decodedPage.message ? decodedPage.message : 'decode-failed',
      });
    }
    let composed;
    try {
      composed = composeCanvasImage({
        page: decodedPage,
        pageRect: decodedPage ? contentRect : null,
        outputRect: rect,
        scale: effectiveScale,
      });
      if (!composed.ok) {
        throw new BrowserError('CAPTURE_FAILED', '画布合成失败', {
          phase: 'compose', reason: composed.message, details: composed.details,
        });
      }
    } catch (error) {
      if (error instanceof BrowserError) throw error;
      throw new BrowserError('CAPTURE_FAILED', '画布合成失败', {
        phase: 'compose', reason: redactText(String(error && error.message ? error.message : error)).slice(0, 200),
      });
    }
    let pngBytes;
    try {
      pngBytes = encodePngRgba({ width: composed.width, height: composed.height, rgba: composed.rgba });
    } catch (error) {
      throw new BrowserError('CAPTURE_FAILED', '合成 PNG 编码失败', {
        phase: 'encodeComposite', reason: redactText(String(error && error.message ? error.message : error)).slice(0, 200),
      });
    }
    return finish({
      base64: pngBytes.toString('base64'),
      pngBytes,
      capture: { ...baseCapture, pageCapture, composite: true },
    });
  }

  /** Opt-in panel overlay. Raw capture/T3/T4 callers keep the original PNG path. */
  async compositeCaptureAnnotations(shot, document, context, signal) {
    const assertContext = () => {
      const current = this.annotationContext();
      if (current.documentKey !== context.documentKey
        || current.pageGeneration !== context.pageGeneration
        || current.documentEpoch !== context.documentEpoch) {
        throw new BrowserError('CAPTURE_FAILED', '截图期间页面已切换，请重新读取标注并截图', {
          phase: 'annotationOverlay', reason: 'annotation-context-changed',
        });
      }
    };
    assertContext();
    if (document.shapes.length && (!document.context
      || document.context.documentKey !== context.documentKey
      || document.context.pageGeneration !== context.pageGeneration
      || document.context.documentEpoch !== context.documentEpoch)) {
      throw new BrowserError('CAPTURE_FAILED', '标注与截图不属于同一页面文档', {
        phase: 'annotationOverlay', reason: 'annotation-context-changed',
      });
    }
    const annotations = {
      enabled: true, composited: false, space: document.space,
      revision: document.revision, updatedAt: document.updatedAt,
      source: document.source, context: document.context,
      shapeCount: document.shapes.length,
      stale: document.stale, staleReason: document.staleReason,
      truncated: document.truncated, truncation: document.truncation,
    };
    shot.capture.annotations = annotations;
    if (!document.shapes.length) return shot;
    const png = inspectPng(shot.pngBytes, { checkCrc: true });
    if (!png.ok) throw new BrowserError('INVALID_PNG', '叠加前的页面 PNG 校验失败', { phase: 'annotationOverlay' });
    const expected = expectedPixelSize({
      width: shot.capture.region.width, height: shot.capture.region.height,
      scale: shot.capture.effectiveScale, deviceScaleFactor: 1,
    });
    const size = checkPixelSize({ width: png.width, height: png.height }, expected);
    if (!size.ok) throw new BrowserError(size.code, '叠加前的页面 PNG 尺寸不符', size.details);
    const renderer = webHostNamespace('annotation-capture');
    try {
      const tree = await this.send('Page.getFrameTree', {}, signal);
      const world = await this.send('Page.createIsolatedWorld', {
        frameId: tree.frameTree.frame.id, worldName: 'dsh-annotation-capture',
      }, signal);
      const input = { shapes: document.shapes, region: shot.capture.region, width: png.width, height: png.height };
      // A detached OffscreenCanvas in an isolated world avoids page prototype overrides and CSP
      // image restrictions. No DOM insertion, image load, page state or extra browser tab.
      const rendered = await this.send('Runtime.evaluate', {
        contextId: world.executionContextId,
        expression: `(${renderer.renderAnnotationOverlay.toString()})(${JSON.stringify(input)})`,
        awaitPromise: true, returnByValue: true,
      }, signal);
      if (rendered.exceptionDetails || !rendered.result?.value?.base64) {
        throw new BrowserError('CAPTURE_FAILED', '标注离屏绘制失败', { phase: 'annotationOverlay', reason: 'raster-failed' });
      }
      assertContext();
      const page = decodePng(shot.pngBytes);
      const overlay = decodePng(Buffer.from(rendered.result.value.base64, 'base64'));
      if (!page.ok || !overlay.ok) {
        throw new BrowserError('CAPTURE_FAILED', '标注叠加 PNG 无法解码', { phase: 'annotationOverlay' });
      }
      const pixels = renderer.compositeAnnotationPixels(page, overlay);
      const pngBytes = encodePngRgba(pixels);
      annotations.composited = true;
      return { ...shot, pngBytes, base64: pngBytes.toString('base64') };
    } catch (error) {
      throw this.#captureError(error, 'annotationOverlay');
    }
  }

  /**
   * Live layout facts for a T3 source/act re-check (docs/t3-vision.md, §6 step 1).
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
    const { picked, missing } = pickComputedStyle(map, properties);
    if (missing.length) {
      // CSS.getComputedStyleForNode reports longhands only: `border-color`, `margin`, `font`, …
      // are absent even when the page has a value. Ask the page for exactly those names.
      const send = (method, params, innerSignal) => this.send(method, params, innerSignal);
      Object.assign(picked, await readComputedStyleFallback(send, node.nodeId, missing, signal));
    }
    return { ok: true, style: picked };
  }

  /* -------------------------------------------------------------------------------------------
   * Web P0 network tool support (docs/network-p0.md). Every method is a thin wrapper over
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
      }
      const status = this.net.status();
      return {
        ok: true, changed: result.changed === true,
        session: status.session, sessions: status.sessions,
        limits: network.limitsView(), subscriptions: status.subscriptions,
        ...sessionAliases(status),
        ...networkStatusAliases(this.net, status),
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
        ...networkStatusAliases(this.net, status),
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
        ...networkStatusAliases(this.net, status),
        evidence: network.evidenceBlock(this.net, 'session.reset'),
      };
    }
    const status = this.net.status();
    return {
      ok: true, changed: false, session: status.session, sessions: status.sessions,
      limits: network.limitsView(), subscriptions: status.subscriptions,
      ...sessionAliases(status),
      ...networkStatusAliases(this.net, status),
      evidence: network.evidenceBlock(this.net, 'session.status'),
    };
  }

  netEvents(args) {
    this.netTouch('events');
    const value = network.queryEvents(this.net, args);
    if (this.net.session) return value;
    // TOOL-P1-04: no session -> an explicitly sessionless, empty window. The store already clears
    // the event ring with the session; the second branch is a defensive boundary against a ghost
    // window (a field report of status=null while events had rows was not reproducible; UNKNOWN).
    const bufferedEvents = Array.isArray(this.net.preSession) ? this.net.preSession.length : 0;
    const base = { ...value, session: null, activeSessionId: null, bufferedEvents };
    if (Array.isArray(this.net.events) && this.net.events.length > 0) {
      return {
        ...base,
        events: [],
        groups: [],
        total: 0,
        returned: 0,
        truncated: false,
        cursor: { next: null },
        evidence: network.evidenceBlock(this.net, 'events', { truncated: false }),
      };
    }
    return base;
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

  /* -------------------------------------------------------------------------------------------
   * FR-11 Cookie Store（cookie-store.js）。三条硬边界：
   *  1. 只读当前 Tab 精确 Origin（CDP Network.getCookies({urls:[origin]})），same-site 不通过。
   *  2. metadata 视图走白名单投影，value 结构性排除；HttpOnly 与普通 Cookie 都只回元数据。
   *  3. export/import 必须有人类签发的授权记录（security-approvals.json，绑定四元组+一次性+
   *     过期+HttpOnly 专项）；Agent 的 confirm 字符串在任何路径上都不参与判定（GATE-03）。
   * Cookie value 只出现在导出文件的字节流里；工具响应、日志、错误消息全部走遮蔽视图。
   * ------------------------------------------------------------------------------------------- */

  #cookieTabId() {
    return this.kind === 'popup' ? (this.viewId || 'primary') : 'primary';
  }

  #cookieScopeQuery(exec) {
    const workspaceId = this.scope && typeof this.scope.workspaceId === 'string' ? this.scope.workspaceId : null;
    return cookieStore.buildApprovalQuery({
      workspaceId,
      runtimeId: this.runtimeId,
      tabId: this.#cookieTabId(),
      origin: cookieStore.originOf(this.url),
      allowHttpOnly: false,
    });
  }

  /**
   * `browser_cookies metadata`：当前 Tab 精确 Origin 的 Cookie 元数据（无 value）。
   * 没有 CDP/页面时返回结构化不可用（不启动浏览器、不报 INTERNAL）。
   */
  async cookieMetadata(args, exec) {
    const origin = cookieStore.originOf(this.url);
    if (origin === null) {
      return {
        ok: false, available: false, reason: 'no-page-origin',
        cookies: [], counts: { total: 0 },
        authScope: { workspaceId: this.scope?.workspaceId ?? null, runtimeId: this.runtimeId, tabId: this.#cookieTabId(), origin: null },
        note: '当前没有已加载的页面或 Origin 不可解析；先导航到目标页面再读取。',
      };
    }
    const result = await this.send('Network.getCookies', { urls: [origin] }, exec?.signal);
    const raw = Array.isArray(result?.cookies) ? result.cookies : [];
    const cookies = [];
    for (const item of raw) {
      const normalized = cookieStore.normalizeCookie(item);
      if (normalized === null) continue; // 异常条目跳过并计数，绝不部分输出 value
      cookies.push(normalized);
    }
    return {
      ok: true, available: true,
      origin,
      authScope: { workspaceId: this.scope?.workspaceId ?? null, runtimeId: this.runtimeId, tabId: this.#cookieTabId(), origin },
      counts: { total: cookies.length, httpOnly: cookies.filter((entry) => entry.httpOnly === true).length, skipped: raw.length - cookies.length },
      cookies: cookies.map((entry) => cookieStore.metadataOf(entry)),
      note: 'metadata 模式只返回元数据；value 与 HttpOnly value 永不返回。导出需要人类签发授权（security-approvals.json）。',
    };
  }

  /**
   * `browser_cookies export`：人类授权后的受控导出。整个流程：
   * 授权校验（fail closed）→ CDP 读 Cookie（精确 Origin）→ 快照组装（整批失败语义）→
   * 持久根内防穿越解析 → 原子 no-clobber 0600 写 → 一次性授权消耗标记 → canary 自检。
   */
  async cookieExport(args, exec) {
    assertKnownKeys(args, ['action', 'out', 'allowHttpOnly'], 'cookies.export');
    if (typeof args.out !== 'string' || args.out.trim() === '') {
      throw new BrowserError('COOKIE_INVALID_ARGUMENT', 'export 需要 out（持久根内相对路径 .json）', { field: 'out' });
    }
    const origin = cookieStore.originOf(this.url);
    if (origin === null) {
      throw new BrowserError('COOKIE_RUNTIME_UNAVAILABLE', '当前没有已加载的页面或 Origin 不可解析；无法确定导出范围', {});
    }
    // ---- 1. 人类授权（Agent confirm 字符串不参与判定，甚至不在参数 schema 里）----------------
    const allowHttpOnly = args.allowHttpOnly === true;
    const query = cookieStore.buildApprovalQuery({
      workspaceId: this.scope?.workspaceId ?? null,
      runtimeId: this.runtimeId,
      tabId: this.#cookieTabId(),
      origin,
      allowHttpOnly,
    });
    const approvalsDir = cookieApprovalsDir();
    const found = cookieStore.findApproval(cookieStore.readApprovals(approvalsDir), query);
    if (!found.ok) {
      throw new BrowserError(found.code, '没有匹配当前 workspace/runtime/tab/origin 的有效人类授权；'
        + '导出被拒绝。请由人类在插件配置目录 security-approvals.json 签发授权记录。', {
        reason: found.reason,
        authScope: { ...query, allowHttpOnly: undefined },
      });
    }
    // ---- 2. CDP 读取（精确 Origin，same-site 不通过）----------------------------------------
    // FR-01: an active scope session counts this CDP read as a dispatch (budget/stop apply);
    // the finally-side complete keeps the inFlight counter leak-free on any outcome.
    this.#scopeCheckDispatch(origin + '/', { kind: 'cookie-export' });
    let result;
    try {
      result = await this.send('Network.getCookies', { urls: [origin] }, exec?.signal);
    } finally {
      this.#scopeCompleteDispatch();
    }
    const raw = Array.isArray(result?.cookies) ? result.cookies : [];
    const cookies = [];
    for (const item of raw) {
      const normalized = cookieStore.normalizeCookie(item);
      if (normalized === null) {
        throw new BrowserError('COOKIE_QUOTA_EXCEEDED', '存在超长或非法 Cookie；整次导出失败，不截断单个条目', {});
      }
      if (allowHttpOnly !== true && normalized.httpOnly === true) continue;
      cookies.push(normalized);
    }
    // ---- 3. 快照组装（整批失败语义，CRED-07）------------------------------------------------
    const snapshot = cookieStore.buildExportSnapshot(cookies, {
      authScope: { workspaceId: this.scope?.workspaceId ?? null, runtimeId: this.runtimeId, tabId: this.#cookieTabId(), origin },
      approvalId: found.approval.approvalId,
      includeHttpOnly: allowHttpOnly,
    });
    if (!snapshot.ok) {
      throw new BrowserError(snapshot.code, snapshot.message, snapshot.details ?? {});
    }
    // ---- 4. 受控文件写入（持久根 + 防穿越 + no-clobber + 0600）------------------------------
    const rootInfo = captureRootFor(exec);
    if (rootInfo.root === null) {
      throw new BrowserError('COOKIE_OUTPUT_ROOT_UNKNOWN', '没有可用的持久证据根：请设置 DSH_UI_TESTING_CAPTURE_DIR 或在有工作区 cwd 的会话内调用', {});
    }
    const stamp = new Date(Date.now()).toISOString().replace(/[:.]/g, '-');
    const defaultName = 'output/cookies/cookie-' + stamp + '-' + cookieStore.COOKIE_STORE_VERSION + '.json';
    const resolved = cookieStore.resolveCookieExportPath({ root: rootInfo.root, out: args.out, defaultName });
    if (!resolved.ok) {
      throw new BrowserError(resolved.code, resolved.message, resolved.details ?? {});
    }
    const published = cookieStore.publishCookieExport(resolved.dir, resolved.absolutePath, snapshot.bytes);
    if (!published.ok) {
      throw new BrowserError(published.code, published.message, published.details ?? {});
    }
    // ---- 5. 一次性授权消耗（成功导出后才标记）----------------------------------------------
    const consumed = cookieStore.markApprovalConsumed(approvalsDir, found.approval.approvalId);
    if (!consumed.ok) {
      // 文件已导出但授权未能标记消耗：如实报告（下一条相同授权仍可用，但这是授权文件的写失败，
      // 不是泄漏）。不回滚导出——回滚并不能收回已写出的字节。
      this.#cookieAudit('approval-consume-failed', { approvalId: found.approval.approvalId, reason: consumed.message });
    }
    // ---- 6. canary 自检（CRED-08）：确认工具响应不含任何 Cookie value/name ------------------
    const responseView = {
      ok: true, action: 'export', origin,
      authScope: { workspaceId: this.scope?.workspaceId ?? null, runtimeId: this.runtimeId, tabId: this.#cookieTabId(), origin },
      file: { pathKind: 'persist', persistence: rootInfo.source, relativePath: resolved.absolutePath.slice(rootInfo.root.length + 1), bytes: published.bytes, mode: published.mode },
      approval: { approvalId: found.approval.approvalId, allowHttpOnly, consumedAt: consumed.ok ? consumed.consumedAt : null },
      counts: snapshot.snapshot.counts,
      canary: cookieStore.canaryScan({ file: resolved.absolutePath.slice(rootInfo.root.length + 1), origin }, cookies),
    };
    // canary 对响应体自身的最终防线：把已导出 value 再扫一遍完整响应对象（file/counts/approval）。
    const selfScan = cookieStore.canaryScan(responseView, cookies);
    if (selfScan !== null) {
      // 理论不可达（响应只含元数据与相对路径）；若发生则说明投影泄漏，必须整次报错而不是返回。
      throw new BrowserError('COOKIE_SCOPE_FORBIDDEN', '导出响应 canary 自检命中 Cookie 明文；响应被拦截，未返回', { hits: selfScan.hits });
    }
    this.#cookieAudit('export', { approvalId: found.approval.approvalId, origin, relativePath: responseView.file.relativePath, bytes: published.bytes, counts: snapshot.snapshot.counts });
    return responseView;
  }

  /**
   * `browser_cookies import`：把此前导出的快照回填当前 Tab 会话（CDP Network.setCookie 逐条）。
   * HttpOnly 条目需要 importHttpOnly 显式开启（且受授权文件约束由工具面拒绝）。
   */
  async cookieImport(args, exec) {
    assertKnownKeys(args, ['action', 'data', 'file', 'importHttpOnly'], 'cookies.import');
    const hasData = typeof args.data === 'string' && args.data.length > 0;
    const hasFile = typeof args.file === 'string' && args.file.length > 0;
    if (hasData === hasFile) {
      throw new BrowserError('COOKIE_INVALID_ARGUMENT', 'import 需要 data 或 file（恰好一个）', {});
    }
    let text;
    let source;
    if (hasData) {
      if (Buffer.byteLength(args.data, 'utf8') > cookieStore.COOKIE_MAX_TOTAL_BYTES) {
        throw new BrowserError('COOKIE_QUOTA_EXCEEDED', 'data 超过导入上限', { max: cookieStore.COOKIE_MAX_TOTAL_BYTES });
      }
      text = args.data;
      source = { kind: 'data' };
    } else {
      const rootInfo = captureRootFor(exec);
      if (rootInfo.root === null) {
        throw new BrowserError('COOKIE_OUTPUT_ROOT_UNKNOWN', '没有可用的持久根读取导入文件', {});
      }
      const resolved = cookieStore.resolveCookieExportPath({ root: rootInfo.root, out: args.file, defaultName: null });
      if (!resolved.ok) {
        throw new BrowserError(resolved.code, resolved.message, resolved.details ?? {});
      }
      try {
        text = readFileSync(resolved.absolutePath, 'utf8');
      } catch (error) {
        throw new BrowserError('COOKIE_IMPORT_INVALID', '导入文件不可读', { reason: error && error.code ? String(error.code) : 'read-failed', file: resolved.absolutePath.slice(rootInfo.root.length + 1) });
      }
      source = { kind: 'file', relativePath: resolved.absolutePath.slice(rootInfo.root.length + 1) };
    }
    const importHttpOnly = args.importHttpOnly === true;
    const parsed = cookieStore.parseCookieImport(text, { importHttpOnly });
    if (!parsed.ok) {
      throw new BrowserError(parsed.code, parsed.message, parsed.details ?? {});
    }
    const origin = cookieStore.originOf(this.url);
    if (origin === null) {
      throw new BrowserError('COOKIE_RUNTIME_UNAVAILABLE', '当前没有已加载的页面或 Origin 不可解析；无法回填会话', {});
    }
    const params = cookieStore.cookieSetParams(parsed.cookies, { url: origin });
    const results = { set: 0, failed: 0 };
    for (const entry of params) {
      try {
        const one = await this.send('Network.setCookie', entry, exec?.signal);
        if (one?.success === true) results.set += 1; else results.failed += 1;
      } catch {
        results.failed += 1;
      }
    }
    const responseView = {
      ok: results.failed === 0, action: 'import', origin, source,
      counts: { total: parsed.counts.total, httpOnly: parsed.counts.httpOnly, set: results.set, failed: results.failed },
      importedScopeOrigin: parsed.scope && typeof parsed.scope.origin === 'string' ? parsed.scope.origin : null,
      note: results.failed > 0 ? '部分条目设置失败（浏览器可能拒绝跨域/过期条目）；失败条目不回传内容。' : null,
    };
    // canary：响应只应含计数与相对路径，绝不含 value。
    const selfScan = cookieStore.canaryScan(responseView, parsed.cookies);
    if (selfScan !== null) {
      throw new BrowserError('COOKIE_SCOPE_FORBIDDEN', '导入响应 canary 自检命中 Cookie 明文；响应被拦截', { hits: selfScan.hits });
    }
    this.#cookieAudit('import', { origin, source, counts: responseView.counts });
    return responseView;
  }

  /** Cookie 操作审计：只记元数据与计数，绝不记 value（CRED-08 的日志面）。 */
  #cookieAudit(operation, details) {
    try {
      const store = this.net;
      if (store && typeof store.mark === 'function' && store.running) {
        store.mark({ kind: 'evidence', tool: 'browser_cookies', text: 'cookie.' + operation + ' ' + JSON.stringify(details) });
      }
    } catch { /* 审计失败不影响主流程 */ }
  }

  /* -------------------------------------------------------------------------------------------
   * FR-01 Scope & Safety Controller（security-scope.js）。会话级授权边界：
   *  - 每个 Runtime 一个 ScopeStore；所有主动派发（navigate / http_request / cookie export 的
   *    CDP 读取）在派发前过 #scopeCheckDispatch。
   *  - 未配置 scope 时普通 GUI 测试完全不受影响（scope 机制按需启用，FR-12）。
   *  - 一旦配置：越界 Origin/路径、超预算、超并发、被动模式下的主动派发全部 0 次实际派发。
   *  - stop 之后 0 次新派发且不可撤销。
   * ------------------------------------------------------------------------------------------- */

  #scopeStore() {
    if (this.#securityScope === null) {
      this.#securityScope = new securityScope.ScopeStore({ scopeId: this.scope.id ?? 'unscoped' });
    }
    return this.#securityScope;
  }

  /**
   * 导航/请求派发前的 scope 闸门。scope 未配置时直接放行（普通 GUI 测试零影响，FR-12）；
   * 已配置时每个 URL（含重定向跳）必须通过 checkDispatch，任何拒绝都以 0 次派发落地。
   */
  #scopeCheckDispatch(url, { actionId = null, kind = 'request', active, method = 'GET', allowDangerous = false } = {}) {
    // A *stopped* session must refuse, not pass: only `null` (never configured) means "no scope
    // module in play" (FR-12). `active=false` with a store present covers both "configured but
    // passive-refusal pending" and "stopped" — both are real refusals, and the store decides
    // which code to throw (INF-07: stop → 0 new dispatches).
    if (this.#securityScope === null) return;
    try {
      this.#securityScope.checkDispatch(url, { actionId, kind, active, method, allowDangerous });
    } catch (refusal) {
      throw new BrowserError(refusal.code, refusal.message, refusal.details ?? {});
    }
  }

  #scopeCompleteDispatch() {
    if (this.#securityScope !== null) this.#securityScope.completeDispatch();
  }

  /**
   * Independent-HTTP half of the FR-01 gate: the same origin/path/budget/danger rules apply to
   * `browser_http_request` when this workspace has an active scope session. Called through the
   * tool wrapper (kept as public methods so the wrapper never reaches into private state).
   */
  scopeGuardHttp({ url, method = 'GET', actionId = null }) {
    this.#scopeCheckDispatch(url, { actionId, kind: 'http-request', method, active: true });
  }

  scopeCompleteHttpDispatch() {
    this.#scopeCompleteDispatch();
  }

  /* -------------------------------------------------------------------------------------------
   * FR-03/FR-04 JavaScript 静态分析（script-analysis.js）。Debugger 域是入侵性能力，按需启用：
   * `browser_script armed=true` 才 Debugger.enable；未启用时所有动作返回 armed:false 的结构化
   * 状态（不伪装成"没有脚本"）。源码、字符串表与 sink 结论都带回链位置与置信度。
   * ------------------------------------------------------------------------------------------- */

  /** 确保 Debugger 域已启用（幂等；只有显式 armed 时才调用）。 */
  async scriptArm(signal) {
    if (this.scriptRegistry !== null) return { ok: true, alreadyArmed: true };
    await this.send('Debugger.enable', {}, signal);
    this.scriptRegistry = [];
    return { ok: true, alreadyArmed: false };
  }

  /* -------------------------------------------------------------------------------------------
   * FR-08 业务逻辑测试（business-logic.js）。判定基于**服务端最终状态**观测，不是请求本身。
   * 每个确认问题必须经 ≥2 次复现（BIZ-05）；状态仍由 finding.deriveStatus 推导。
   * ------------------------------------------------------------------------------------------- */

  /** `browser_biz evaluate`：对已观测的业务事实执行不变量检查。 */
  bizEvaluate(args) {
    const facts = args?.facts && typeof args.facts === 'object' ? args.facts : {};
    const result = businessLogic.evaluateBusinessLogic(facts);
    return {
      ok: true,
      ...result,
      candidates: result.candidates.map((candidate) => ({
        ...candidate,
        allowedStatus: findingLib.deriveStatus({ basis: candidate.basis }).status,
      })),
    };
  }

  /**
   * `browser_biz probe`：按场景模板对目标执行一组受控请求并采集**服务端状态**。
   * 只做非破坏性观测（加购可用负数仅为观测量级，真实破坏性操作被 scope 危险闸门拦截）。
   */
  async bizProbe(args, exec) {
    const origin = cookieStore.originOf(this.url) ?? null;
    if (origin === null) {
      throw new BrowserError('BIZ_INVALID_ARGUMENT', '当前没有可用的页面 Origin；先导航到目标页面', {});
    }
    const scenario = String(args?.scenario ?? '');
    const base = String(args?.basePath ?? origin).replace(/\/$/, '');
    const call = async (path, { method = 'GET', body = null } = {}) => {
      // Every probe goes through the same scope gate as any other dispatch (origin/path/budget/
      // danger). A probe must never become a scope escape hatch.
      this.#scopeCheckDispatch(base + path, { kind: 'biz-probe', method, active: true });
      try {
        const options = { method, headers: {}, credentials: 'include' };
        if (body !== null) {
          options.headers['Content-Type'] = 'application/json';
          options.body = JSON.stringify(body);
        }
        const response = await this.evaluate(`(async () => {
          const r = await fetch(${JSON.stringify(base + path)}, ${JSON.stringify(options)});
          let text = '';
          try { text = await r.text(); } catch { text = ''; }
          return JSON.stringify({ status: r.status, body: text.slice(0, 4096) });
        })()`, true, exec?.signal);
        const raw = response?.value ?? '{}';
        const parsed = typeof raw === 'string' ? JSON.parse(raw) : raw;
        let json = null;
        try { json = JSON.parse(parsed.body); } catch { /* non-JSON body is fine */ }
        return { status: parsed.status, body: parsed.body, json };
      } finally {
        this.#scopeCompleteDispatch();
      }
    };

    if (scenario === 'cart-quantity') {
      // BIZ-01: push boundary quantities and read the resulting server cart.
      //
      // The lab's cart ACCUMULATES adds, so a previous run's residue would make each observation
      // describe history instead of its own input (measured: a stale +199986 qty hid the negative
      // subtotal). When `resetQty` is on (default true) the scenario first neutralises the product
      // line by adding its exact negative, then applies each variant from a known baseline.
      const variants = Array.isArray(args?.variants) ? args.variants : [-5, 0, 100000];
      const productId = Number.isInteger(args?.productId) ? args.productId : 1;
      const resetQty = args?.resetQty !== false;
      const reset = { attempted: false, before: null, after: null };
      if (resetQty) {
        const before = await call('/api/cart');
        const line = (Array.isArray(before.json?.items) ? before.json.items : [])
          .find((item) => Number(item?.product_id) === productId);
        const currentQty = Number.isFinite(Number(line?.qty)) ? Number(line.qty) : 0;
        reset.before = currentQty;
        if (currentQty !== 0) {
          await call('/api/cart/add', { method: 'POST', body: { productId, qty: -currentQty } });
          const after = await call('/api/cart');
          const lineAfter = (Array.isArray(after.json?.items) ? after.json.items : [])
            .find((item) => Number(item?.product_id) === productId);
          reset.after = Number.isFinite(Number(lineAfter?.qty)) ? Number(lineAfter.qty) : 0;
          reset.attempted = true;
        } else {
          reset.after = 0;
        }
      }
      const observations = [];
      for (const qty of variants) {
        const added = await call('/api/cart/add', { method: 'POST', body: { productId, qty } });
        const cart = await call('/api/cart');
        observations.push({
          input: { qty },
          accepted: added.status >= 200 && added.status < 300,
          addResponse: added.json,
          cartState: cart.json,
        });
      }
      return { ok: true, scenario, reset, observations, evaluated: businessLogic.checkQuantityBoundaries(observations) };
    }

    if (scenario === 'coupon-reuse') {
      // BIZ-02: apply the same coupon N times and read the accumulated discount.
      const code = String(args?.code ?? 'WELCOME10');
      const times = Number.isInteger(args?.times) && args.times > 0 ? Math.min(args.times, 5) : 2;
      const applications = [];
      for (let index = 0; index < times; index += 1) {
        const applied = await call('/api/coupons/apply', { method: 'POST', body: { code } });
        const cart = await call('/api/cart');
        applications.push({
          code,
          ok: applied.status >= 200 && applied.status < 300,
          applyResponse: applied.json,
          discount: cart.json?.discount ?? null,
          total: cart.json?.total ?? null,
        });
      }
      return { ok: true, scenario, applications, evaluated: businessLogic.checkCouponReuse(applications) };
    }

    if (scenario === 'order-state') {
      // BIZ-04: read the identity's orders and record their observed states (no mutations).
      const orders = await call('/api/orders');
      return {
        ok: true, scenario,
        orders: Array.isArray(orders.json?.orders) ? orders.json.orders : [],
        note: '只读观测：状态迁移测试需要具备受控的写路径，当前只采集状态基线，不做非法迁移尝试。',
      };
    }

    if (scenario === 'snapshot') {
      // A read-only baseline: cart + orders + products in one call.
      const [cart, orders, products] = await Promise.all([call('/api/cart'), call('/api/orders'), call('/api/products')]);
      return { ok: true, scenario, cart: cart.json, orders: orders.json, products: products.json };
    }

    throw new BrowserError('BIZ_INVALID_ARGUMENT', 'biz.probe.scenario 不合法: ' + scenario, {
      allowed: ['cart-quantity', 'coupon-reuse', 'order-state', 'snapshot'],
    });
  }

  /* -------------------------------------------------------------------------------------------
   * FR-09/FR-10 Finding 与报告（finding.js / security-rules.js）。
   * 硬规则：状态只能由 evidenceBasis 经 deriveStatus 推导——调用方不能直接指定 confirmed。
   * 每条 Finding 必须带 actionId 与时间戳；证据可以是请求/响应/DOM/脚本位置/网络 seq。
   * ------------------------------------------------------------------------------------------- */

  #findingsLazy() {
    if (this.securityFindings === null) this.securityFindings = [];
    return this.securityFindings;
  }

  /** `browser_findings add`：登记一条 Finding（状态由证据类型推导，不接受调用方指定）。 */
  findingsAdd(args, exec) {
    const list = this.#findingsLazy();
    const actionId = exec?.meta?.actionId ?? null;
    const basis = String(args?.evidenceBasis ?? 'observed-once');
    const reproductions = Number.isInteger(args?.reproductions) ? args.reproductions : 0;
    const hasContrast = args?.hasContrast === true;
    const requestedStatus = typeof args?.status === 'string' ? args.status : null;
    const derived = findingLib.deriveStatus({ basis, reproductions, hasContrast, requested: requestedStatus });
    const finding = findingLib.createFindingSkeleton({
      ...args,
      findingId: typeof args?.findingId === 'string' && args.findingId !== ''
        ? args.findingId
        : 'F-' + (list.length + 1).toString().padStart(3, '0'),
      actionId,
      evidenceBasis: basis,
      reproductions,
      hasContrast,
    });
    // The caller may ASK for a status; the derived one wins and the difference is reported.
    finding.status = derived.status;
    if (requestedStatus !== null && requestedStatus !== derived.status) {
      finding.notes.push('请求状态 ' + requestedStatus + ' 被降级为 ' + derived.status + '：' + derived.reason);
    }
    finding.actionId = actionId ?? finding.actionId;
    if (list.some((entry) => entry.findingId === finding.findingId)) {
      throw new BrowserError('FINDING_INVALID_ARGUMENT', 'findingId 重复: ' + finding.findingId, { findingId: finding.findingId });
    }
    list.push(finding);
    return {
      ok: true, finding,
      derivation: derived,
      note: '状态由证据类型推导：static-pattern→potential，observed-once→likely，'
        + 'differential/reproduced 且 ≥2 次复现+对照→confirmed。',
    };
  }

  /** `browser_findings evaluate`：对观测事实跑安全规则，返回候选（不自动入库）。 */
  findingsEvaluate(args) {
    const facts = args?.facts && typeof args.facts === 'object' ? args.facts : {};
    const result = securityRules.evaluateRules(facts);
    return {
      ok: true,
      ...result,
      // Each candidate is tagged with the status its own basis allows, so a caller cannot smuggle
      // a static pattern in as confirmed.
      candidates: result.candidates.map((candidate) => ({
        ...candidate,
        allowedStatus: findingLib.deriveStatus({ basis: candidate.basis }).status,
      })),
    };
  }

  /** `browser_findings list`：清单 + 汇总（按严重性/状态/完整率）。 */
  findingsList(args) {
    const list = this.#findingsLazy();
    const severity = typeof args?.severity === 'string' ? args.severity.toLowerCase() : null;
    const status = typeof args?.status === 'string' ? args.status : null;
    const filtered = list.filter((finding) => (severity === null || finding.severity === severity)
      && (status === null || finding.status === status));
    return {
      ok: true,
      total: list.length,
      returned: filtered.length,
      summary: findingLib.summarizeFindings(list),
      findings: filtered.map((finding) => ({
        findingId: finding.findingId,
        title: finding.title,
        category: finding.category,
        severity: finding.severity,
        status: finding.status,
        confidence: finding.confidence,
        endpoint: finding.endpoint,
        evidenceBasis: finding.evidenceBasis,
        actionId: finding.actionId,
        createdAt: finding.createdAt,
        complete: findingLib.gradeFinding(finding).complete,
      })),
    };
  }

  /** `browser_findings grade`：单条完整度 + 缺失字段（EVD-01..04）。 */
  findingsGrade(args) {
    const id = String(args?.findingId ?? '');
    const finding = this.#findingsLazy().find((entry) => entry.findingId === id);
    if (!finding) throw new BrowserError('FINDING_NOT_FOUND', '未找到该 Finding', { findingId: id });
    return { ok: true, findingId: id, grade: findingLib.gradeFinding(finding), evidence: findingLib.evidenceCompleteness([finding]) };
  }

  /** `browser_findings report`：结构化报告 + 脱敏自检（EVD-06）。 */
  findingsReport(args) {
    const list = this.#findingsLazy();
    const summary = findingLib.summarizeFindings(list);
    // EVD-06: scan for canary values the caller knows about (e.g. exported cookie values).
    const canaries = Array.isArray(args?.canaries) ? args.canaries : [];
    const scan = findingLib.scanFindingsForSecrets(list, canaries);
    return {
      ok: true,
      kind: 'dsh-ui-testing-security-report',
      version: findingLib.FINDING_VERSION,
      generatedAt: Date.now(),
      summary,
      canaryScan: scan,
      findings: list,
      note: summary.evidence.highBarMet
        ? 'High/Critical 证据完整率满足 100% 门槛。'
        : 'High/Critical 证据完整率未达 100% 门槛（EVD-02），不得宣称验收通过。',
    };
  }

  /**
   * `browser_findings reproduce`（EVD-05）：按 Finding 里记录的请求**真实重放一次**，
   * 与服务端这次的回答比对，得出"能否独立复现"。
   *
   * 与 `retest` 的区别：`retest` 只把调用方报告的结论记账；`reproduce` 自己派发请求，
   * 所以它回答的是"换一个人按同样的请求打一次，还会得到同样的结果吗"。
   * 请求仍走 scope 闸门（越界/危险操作不会因为"复现"而放行）。
   */
  async findingsReproduce(args, exec) {
    const id = String(args?.findingId ?? '');
    const finding = this.#findingsLazy().find((entry) => entry.findingId === id);
    if (!finding) throw new BrowserError('FINDING_NOT_FOUND', '未找到该 Finding', { findingId: id });
    const recorded = finding.request;
    if (recorded === null || typeof recorded !== 'object' || typeof recorded.url !== 'string' || recorded.url === '') {
      throw new BrowserError('FINDING_INVALID_ARGUMENT', '该 Finding 没有可重放的请求记录（缺 request.url）', { findingId: id });
    }
    // A relative recorded URL is resolved against the finding's target, so a replay hits the same
    // host the finding was taken from.
    let target;
    try {
      target = new URL(recorded.url, finding.targetUrl ?? this.url ?? undefined).toString();
    } catch {
      throw new BrowserError('FINDING_INVALID_ARGUMENT', '记录的请求 URL 无法解析', { url: recorded.url });
    }
    const method = String(recorded.method ?? 'GET').toUpperCase();
    // The replay is a dispatch like any other: the scope gate decides, and a refusal is reported
    // as a refusal (never silently counted as "reproduced").
    this.#scopeCheckDispatch(target, { kind: 'finding-reproduce', method, active: true, actionId: exec?.meta?.actionId });
    let observed;
    try {
      const spec = JSON.stringify({
        method,
        body: typeof recorded.body === 'string' ? recorded.body : null,
        headers: recorded.headers && typeof recorded.headers === 'object' ? recorded.headers : {},
      });
      const raw = await this.evaluate(`(async () => {
        const spec = ${spec};
        try {
          const response = await fetch(${JSON.stringify(target)}, {
            method: spec.method,
            credentials: 'include',
            headers: Object.assign({}, spec.headers, spec.body === null ? {} : { 'Content-Type': 'application/json' }),
            body: spec.body === null ? undefined : spec.body,
          });
          const text = await response.text();
          return JSON.stringify({ status: response.status, length: text.length, body: text.slice(0, 2000) });
        } catch (error) {
          return JSON.stringify({ status: 0, length: 0, body: String(error).slice(0, 200) });
        }
      })()`, true, exec?.signal);
      observed = typeof raw?.value === 'string' ? JSON.parse(raw.value) : (raw?.value ?? { status: 0 });
    } finally {
      this.#scopeCompleteDispatch();
    }

    const expectedStatus = Number.isInteger(recorded.status) ? recorded.status : null;
    const recordedBody = typeof finding.response?.body === 'string' ? finding.response.body : '';
    const statusMatches = expectedStatus !== null && observed.status === expectedStatus;
    // Body agreement is compared on a bounded prefix: a byte-identical match is not required for
    // a finding whose value is "same class of answer" (e.g. an authorization bypass returning a
    // different object), but a completely different answer must NOT count as reproduced.
    const bodyMatches = recordedBody === '' ? null : observed.body.startsWith(recordedBody.slice(0, 120));
    const reproduced = statusMatches && (bodyMatches !== false);
    if (reproduced) finding.reproductions += 1;
    else finding.hasContrast = true; // a failed replay is a real contrast observation
    const derived = findingLib.deriveStatus({
      basis: finding.evidenceBasis ?? 'observed-once',
      reproductions: finding.reproductions,
      hasContrast: finding.hasContrast,
    });
    const before = finding.status;
    finding.status = derived.status;
    finding.retest = {
      at: Date.now(), reproduced, reproductions: finding.reproductions,
      statusBefore: before, statusAfter: derived.status,
      note: 'reproduce: 独立重放', actionId: exec?.meta?.actionId ?? null,
    };
    return {
      ok: true,
      findingId: id,
      reproduced,
      expected: { status: expectedStatus, bodyPrefix: recordedBody.slice(0, 120) || null },
      observed: { status: observed.status, length: observed.length, bodyPrefix: String(observed.body ?? '').slice(0, 120) },
      comparison: {
        request: { method, url: target },
        statusMatches,
        bodyMatches,
        basis: 'replayed the recorded request and compared the server answer',
      },
      statusBefore: before,
      statusAfter: derived.status,
      note: reproduced
        ? '重放得到与记录一致的结果——可独立复现（EVD-05）。'
        : '重放结果与记录不一致：或已修复，或记录不准确。已记为对照观测，不提升状态。',
    };
  }

  /** `browser_findings retest`：记录一次复测结果（更新复现计数与状态）。 */
  findingsRetest(args) {
    const id = String(args?.findingId ?? '');
    const finding = this.#findingsLazy().find((entry) => entry.findingId === id);
    if (!finding) throw new BrowserError('FINDING_NOT_FOUND', '未找到该 Finding', { findingId: id });
    const reproduced = args?.reproduced === true;
    if (reproduced) finding.reproductions += 1;
    else finding.hasContrast = true; // a successful contradiction is a contrast verification
    finding.hasContrast = finding.hasContrast || args?.hasContrast === true;
    const derived = findingLib.deriveStatus({
      basis: finding.evidenceBasis ?? 'observed-once',
      reproductions: finding.reproductions,
      hasContrast: finding.hasContrast,
    });
    const before = finding.status;
    finding.status = derived.status;
    finding.retest = {
      at: Date.now(),
      reproduced,
      reproductions: finding.reproductions,
      statusBefore: before,
      statusAfter: derived.status,
      note: typeof args?.note === 'string' ? args.note.slice(0, 500) : null,
      actionId: null,
    };
    return { ok: true, findingId: id, statusBefore: before, statusAfter: derived.status, derivation: derived };
  }

  /* -------------------------------------------------------------------------------------------
   * FR-05 运行时分析（runtime-debug.js）：断点、暂停栈、变量投影与请求关联。
   * RT-06 的硬规则：任何暂停都必须能在 DEBUG_LIMITS.pauseTimeoutMs 内恢复——每个涉及暂停的
   * 动作结束时都检查守卫，超时立即 Debugger.resume（页面永不因我们而永久挂起）。
   * ------------------------------------------------------------------------------------------- */

  #debugBookLazy() {
    if (this.debugBook === null) this.debugBook = new runtimeDebug.BreakpointBook();
    return this.debugBook;
  }

  #debugGuardLazy() {
    if (this.debugGuard === null) this.debugGuard = new runtimeDebug.PauseGuard();
    return this.debugGuard;
  }

  /** RT-06：超时即恢复。返回是否真的发送了 resume（供动作层如实报告）。 */
  async #debugEnforceTimeout(signal) {
    const guard = this.debugGuard;
    if (guard === null) return { resumed: false, paused: false };
    const state = guard.checkTimeout();
    if (state.mustResume !== true) return { resumed: false, paused: state.paused, elapsedMs: state.elapsedMs };
    try {
      await this.send('Debugger.resume', {}, signal);
    } catch { /* a failed resume must still leave the guard closed; the page may have resumed itself */ }
    return { resumed: true, paused: false, reason: 'pause-timeout' };
  }

  /** `browser_script breakpoint`：设置/列出/移除断点（RT-01）。 */
  async scriptBreakpoint(args, signal) {
    if (this.scriptRegistry === null) {
      throw new BrowserError('SCRIPT_NOT_ARMED', 'Debugger 未启用：先调用 browser_script armed=true', {});
    }
    const op = String(args?.op ?? 'set');
    const book = this.#debugBookLazy();
    this.#debugGuardLazy();
    if (op === 'list') {
      return { ok: true, op, breakpoints: book.projection(), pause: this.debugGuard.projection() };
    }
    if (op === 'set') {
      const definition = runtimeDebug.normalizeBreakpoint(args || {});
      if (definition === null) {
        throw new BrowserError('SCRIPT_INVALID_ARGUMENT', '断点需要 url 与 lineNumber（非负整数）', { field: 'url/lineNumber' });
      }
      const params = {
        url: definition.url,
        lineNumber: definition.lineNumber,
        columnNumber: definition.columnNumber,
      };
      if (definition.condition !== null) params.condition = definition.condition;
      const result = await this.send('Debugger.setBreakpointByUrl', params, signal);
      const registered = book.register(result?.breakpointId, definition, { locations: result?.locations });
      if (!registered?.ok) {
        throw new BrowserError(registered?.code ?? 'SCRIPT_INVALID_ARGUMENT', registered?.message ?? '断点登记失败', registered?.details ?? {});
      }
      return {
        ok: true, op, breakpoint: {
          cdpBreakpointId: result?.breakpointId ?? null,
          label: definition.label,
          url: definition.url,
          lineNumber: definition.lineNumber,
          columnNumber: definition.columnNumber,
          condition: definition.condition,
          resolved: registered.record.resolved,
          locations: registered.record.locations,
        },
        note: registered.record.resolved
          ? '断点已解析到脚本位置；命中情况见 op=list 的 hitCount。'
          : 'URL 未匹配到已加载脚本：断点在脚本加载后才会解析（hitCount 保持 0 直到真正命中）。',
      };
    }
    if (op === 'remove') {
      const id = typeof args?.cdpBreakpointId === 'string' ? args.cdpBreakpointId
        : (typeof args?.label === 'string' ? book.findByLabel(args.label)?.cdpBreakpointId ?? null : null);
      if (id === null) throw new BrowserError('SCRIPT_INVALID_ARGUMENT', 'remove 需要 cdpBreakpointId 或已登记的 label', {});
      const removed = book.remove(id);
      if (!removed.ok) throw new BrowserError('SCRIPT_NOT_FOUND', '断点不存在或已移除', { cdpBreakpointId: id });
      try { await this.send('Debugger.removeBreakpoint', { breakpointId: id }, signal); } catch { /* CDP may already have dropped it */ }
      return { ok: true, op, removed: { cdpBreakpointId: id, label: removed.record.label, hitCount: removed.record.hits } };
    }
    throw new BrowserError('SCRIPT_INVALID_ARGUMENT', 'breakpoint.op 不合法: ' + op, { allowed: ['set', 'list', 'remove'] });
  }

  /** `browser_script stack`：最近一次暂停的调用栈（RT-02），不含任何变量值。 */
  async scriptStack(args, signal) {
    if (this.debugGuard === null || this.lastPause === null) {
      return { ok: true, paused: false, callFrames: [], note: '当前没有暂停记录；先设置断点并触发，或使用 op=wait。' };
    }
    const guard = await this.#debugEnforceTimeout(signal);
    const frames = (this.lastPause.callFrames ?? []).slice(0, runtimeDebug.DEBUG_LIMITS.maxCallFrames)
      .map((frame, index) => runtimeDebug.projectCallFrame(frame, { index }));
    return {
      ok: true,
      paused: guard.paused,
      reason: this.lastPause.reason,
      hitBreakpoints: this.lastPause.hitBreakpoints,
      callFrames: frames,
      pause: this.debugGuard.projection(),
      note: 'callFrameId 与 objectId 不会返回：它们是 live handle，只保留可复核的位置信息。',
    };
  }

  /**
   * `browser_script scope`：暂停时的作用域变量（RT-03），**默认脱敏**（RT-07）。
   * 变量来自 CDP Runtime.getProperties；敏感名只回类型与长度。
   */
  async scriptScope(args, signal) {
    if (this.lastPause === null) {
      return { ok: true, paused: false, scopes: [], note: '当前没有暂停记录。' };
    }
    const guard = await this.#debugEnforceTimeout(signal);
    const scopeChain = this.lastPause.scopeChain ?? [];
    const wantedIndex = Number.isInteger(args?.scopeIndex) ? args.scopeIndex : null;
    // Fetch properties lazily: only for the requested scope (or all when unspecified).
    const cache = new Map();
    const variablesOf = (index) => {
      if (wantedIndex !== null && index !== wantedIndex) return null;
      if (cache.has(index)) return cache.get(index);
      const scopeObject = scopeChain[index]?.object;
      let out = null;
      if (scopeObject?.objectId) {
        out = this.send('Runtime.getProperties', {
          objectId: scopeObject.objectId, ownProperties: true, accessorPropertiesOnly: false, generatePreview: false,
        }, signal).then((result) => Array.isArray(result?.result) ? result.result : []).catch(() => []);
      }
      cache.set(index, out);
      return out;
    };
    checkAbort(signal);
    // Resolve the requested scopes in one pass (the helper returns promises).
    const scopes = [];
    for (let index = 0; index < scopeChain.length; index += 1) {
      const scope = scopeChain[index];
      const pending = variablesOf(index);
      const raw = pending === null ? [] : await pending;
      scopes.push(runtimeDebug.projectScopes([scope], {
        variablesOf: () => raw,
      })[0]);
    }
    return {
      ok: true,
      paused: guard.paused,
      scopes,
      pause: this.debugGuard.projection(),
      note: '敏感变量（cookie/token/session/签名/盐等）只返回类型与长度，值不回传（RT-07）。',
    };
  }

  /** `browser_script resume`：显式恢复（RT-06 的手动路径）。 */
  async scriptResume(signal) {
    const guard = this.#debugGuardLazy();
    const wasPaused = guard.projection().paused;
    try { await this.send('Debugger.resume', {}, signal); } catch { /* already resumed */ }
    guard.resume();
    this.lastPause = null;
    return { ok: true, wasPaused, pause: guard.projection() };
  }

  /** `browser_script correlate`：把暂停栈与网络请求关联（RT-02/RT-04）。 */
  scriptCorrelate(args) {
    if (this.lastPause === null) {
      return { ok: true, paused: false, correlations: [], note: '当前没有暂停记录，无法关联。' };
    }
    const store = this.net;
    const events = (store.events ?? []).filter((event) => event?.kind === 'http' && event.phase === 'request');
    const wanted = Number.isInteger(args?.limit) && args.limit > 0 ? Math.min(args.limit, 50) : 10;
    const correlations = [];
    for (const event of events.slice(-wanted)) {
      const result = runtimeDebug.correlatePauseWithRequest(
        { pausedAtMs: this.lastPause.pausedAtMs, callFrames: this.lastPause.callFrames },
        { url: event.url, atMs: event.ts?.wallMs ?? null, initiator: event.initiator ?? null },
        { beforeMs: Number.isInteger(args?.beforeMs) ? args.beforeMs : 250, afterMs: Number.isInteger(args?.afterMs) ? args.afterMs : 1000 },
      );
      correlations.push({
        requestUrl: event.url,
        requestMethod: event.method,
        firstSeq: event.seq,
        grade: result.grade,
        basis: result.basis,
        evidence: result.evidence,
      });
    }
    return {
      ok: true,
      paused: this.debugGuard === null ? false : this.debugGuard.projection().paused,
      correlations,
      note: 'grade: confirmed(initiator 栈匹配) / likely(同脚本 URL) / possible(仅时间邻近，不是因果) / null(无法关联)。',
    };
  }

  /** `browser_script verify`：静态签名结论 vs 运行时参数的逐项比对（RT-05）。 */
  scriptVerify(args) {
    const expected = args?.expected && typeof args.expected === 'object' ? args.expected : null;
    const observed = args?.observed && typeof args.observed === 'object' ? args.observed : null;
    if (expected === null || observed === null) {
      throw new BrowserError('SCRIPT_INVALID_ARGUMENT', 'verify 需要 expected 与 observed 两个对象', {});
    }
    return { ok: true, ...runtimeDebug.verifySignatureAtRuntime({ expected, observed }) };
  }

  /** `browser_script list`：脚本清单（JS-01）。未启用 Debugger 时返回结构化未启用状态。 */
  scriptInventory() {
    if (this.scriptRegistry === null) {
      return { ok: true, armed: false, note: 'Debugger 未启用：先用 browser_script armed=true 打开脚本清单采集（Debugger.enable 是入侵性操作，按需开启）。', inventory: null };
    }
    return { ok: true, armed: true, inventory: scriptAnalysis.buildScriptInventory(this.scriptRegistry) };
  }

  /** 取回一个脚本的源码（JS-02）。按 scriptId 或 URL 精确匹配；不回显源码片段到日志。 */
  async scriptSource(args, signal) {
    if (this.scriptRegistry === null) {
      throw new BrowserError('SCRIPT_NOT_ARMED', 'Debugger 未启用：先调用 browser_script armed=true', {});
    }
    const wanted = String(args?.scriptId ?? args?.url ?? '');
    if (wanted === '') throw new BrowserError('SCRIPT_INVALID_ARGUMENT', '需要 scriptId 或 url', {});
    const descriptor = this.scriptRegistry.find((entry) => entry.scriptId === wanted)
      ?? this.scriptRegistry.find((entry) => entry.url === wanted);
    if (!descriptor) throw new BrowserError('SCRIPT_NOT_FOUND', '未找到该脚本（可能未加载或已卸载）', { wanted });
    let fetched;
    try {
      fetched = await this.send('Debugger.getScriptSource', { scriptId: descriptor.scriptId }, signal);
    } catch (error) {
      // Chromium answers "No script for id: N" for an id from an unloaded document. That is a
      // scope answer (the script is gone), not an internal fault — REG-04 forbids INTERNAL here.
      const message = String(error?.message ?? error ?? '');
      if (/No script for id|Cannot find context|Script not found/i.test(message)) {
        throw new BrowserError('SCRIPT_NOT_FOUND', '该脚本已随文档卸载；重新 armed 或刷新后重试', {
          scriptId: descriptor.scriptId, cdpMessage: message.slice(0, 160),
        });
      }
      throw error;
    }
    const source = String(fetched?.scriptSource ?? '');
    const bytes = Buffer.byteLength(source, 'utf8');
    if (bytes > scriptAnalysis.SCRIPT_LIMITS.maxSourceBytes) {
      throw new BrowserError('SCRIPT_TOO_LARGE', '脚本超过分析上限；不截断返回（避免把部分源码当完整源码）', { bytes, max: scriptAnalysis.SCRIPT_LIMITS.maxSourceBytes });
    }
    return {
      ok: true,
      script: { ...descriptor, bytes, sha256: createHash('sha256').update(source, 'utf8').digest('hex') },
      source,
      sourceMap: scriptAnalysis.scriptMapStatus({ sourceMapUrl: descriptor.sourceMapUrl }),
      note: 'source 是浏览器提供的脚本内容；格式化结果不是原始源码。',
    };
  }

  /** `browser_script format`：格式化 + 精确 lineMap（JS-02）。 */
  async scriptFormat(args, signal) {
    const found = await this.scriptSource(args, signal);
    const formatted = scriptAnalysis.formatScript(found.source);
    if (!formatted.ok) throw new BrowserError('SCRIPT_TOO_LARGE', '格式化失败：' + formatted.reason, formatted);
    return {
      ok: true, script: found.script, sourceMap: found.sourceMap,
      formatted: { text: formatted.text, lineMap: formatted.lineMap, isOriginalSource: false, note: formatted.note },
    };
  }

  /** `browser_script strings`：字符串表识别与还原（JS-04）。 */
  async scriptStrings(args, signal) {
    const found = await this.scriptSource(args, signal);
    const tables = scriptAnalysis.extractStringTables(found.source);
    const rotation = scriptAnalysis.detectArrayRotation(found.source);
    return {
      ok: true, script: found.script,
      stringTables: tables,
      rotation,
      counts: {
        tables: tables.length,
        entries: tables.reduce((sum, table) => sum + table.count, 0),
        decoded: tables.reduce((sum, table) => sum + table.decoded.filter((d) => d.status === 'decoded').length, 0),
        unknown: tables.reduce((sum, table) => sum + table.decoded.filter((d) => d.status === 'unknown').length, 0),
      },
      note: 'status=decoded 为可确定还原；status=plain 是本来可读的字符串（不是还原）；status=unknown 表示无法静态还原，不做伪造。',
    };
  }

  /** `browser_script sinks`：Source-to-Sink 静态定位（JS-07）。 */
  async scriptSinks(args, signal) {
    const found = await this.scriptSource(args, signal);
    const result = scriptAnalysis.findSourceToSink(found.source);
    return {
      ok: true, script: found.script, ...result,
      note: '静态模式命中不等于可利用：confidence=low 表示没找到数据来源，不能声称可注入。',
    };
  }

  /** `browser_script analyze`：综合结论（JS-08 可选运行时一致性对照）。 */
  async scriptAnalyze(args, signal) {
    const found = await this.scriptSource(args, signal);
    const runtime = args?.runtimeValues && typeof args.runtimeValues === 'object' ? args.runtimeValues : null;
    const report = scriptAnalysis.analyzeScript({ descriptor: found.script, source: found.source, runtime });
    return { ok: true, script: found.script, report };
  }

  /**
   * `browser_surface build`（FR-02）：从网络采集事件 + 当前页面 DOM 事实构建结构化 Inventory。
   * 证据分级是契约：网络实发=observed；DOM 表单=inferred；调用方注入的静态线索=unverified。
   * DOM 提取脚本 FIXED（不执行调用方脚本，见 browser_surface 与 browser_eval 的区别）。
   */
  async surfaceBuild(args, exec) {
    assertKnownKeys(args, ['action', 'origin', 'unverifiedPaths'], 'surface.build');
    const origin = args.origin !== undefined && args.origin !== null
      ? String(args.origin)
      : (cookieStore.originOf(this.url) ?? (this.url || null));
    // ---- DOM 事实提取（固定脚本；表单 action/method/fields + 文档标题/地址）----------------
    const domFacts = await this.evaluate(`
      (() => {
        const forms = [...document.querySelectorAll('form')].slice(0, 50).map((form) => ({
          action: form.getAttribute('action') || null,
          method: form.getAttribute('method') || 'GET',
          fields: [...form.querySelectorAll('input,select,textarea')].slice(0, 24).map((field) => ({
            name: field.name || field.id || '',
            type: field.type || field.tagName.toLowerCase(),
            required: field.required === true,
          })),
          submitText: form.querySelector('button,[type=submit]')?.textContent?.trim()?.slice(0, 64) || null,
        }));
        return { forms, title: document.title, url: location.href };
      })()
    `, true, exec?.signal);
    const facts = domFacts?.value ?? {};
    // ---- 事件归一化：只取 collector 里本 scope 的事件-----------------------------------------
    const store = this.net; // lazily creates the store; preSession events included
    const events = store.events;
    const inventory = attackSurface.buildSurfaceInventory({
      events,
      forms: facts.forms ?? [],
      origin,
      unverifiedPaths: args.unverifiedPaths,
      documentTitle: facts.title ?? this.title,
      documentUrl: facts.url ?? this.url,
      // DISC-06: the collector's declared capabilities travel with the inventory so a consumer can
      // tell "declared but not observed" from "not supported".
      collectorDeclared: {
        websocket: this.net.config?.captureWebSocket === true,
        sse: this.net.config?.captureSse === true,
      },
      // Auth state is an OBSERVED fact: request headers live in the collector's own store, so the
      // extraction reads them by requestId instead of guessing from the URL or the UI.
      // Same store pattern as headers: the body is addressed by requestId, never guessed.
      readBody: (requestId, event) => {
        try {
          const stored = this.net.readBody({
            targetId: event?.targetId ?? null,
            cdpSessionId: event?.cdpSessionId ?? null,
            requestId,
            hopId: Number.isInteger(event?.hopId) ? event.hopId : 0,
            kind: 'request',
          });
          if (stored === null || typeof stored !== 'object') return '';
          // `readBody` answers a structured block: `data` carries the text (utf8 or base64), and
          // `payloadOmitted`/`available` say whether there is anything to read at all.
          if (stored.available !== true || stored.payloadOmitted === true) return '';
          const data = typeof stored.data === 'string' ? stored.data : '';
          if (data === '') return '';
          if (stored.base64Encoded === true) {
            try { return Buffer.from(data, 'base64').toString('utf8'); } catch { return ''; }
          }
          return data;
        } catch { return ''; }
      },
      readHeaders: (requestId, event) => store.readHeaders({
        targetId: event?.targetId ?? null,
        cdpSessionId: event?.cdpSessionId ?? null,
        requestId,
        hopId: Number.isInteger(event?.hopId) ? event.hopId : 0,
        kind: 'request',
      }),
    });
    this.#cookieAudit('surface-build', { origin, counts: inventory.counts, actionId: exec?.meta?.actionId ?? null });
    return {
      ok: true,
      inventory,
      note: 'evidence 分级：apiOperations/pageRoutes=observed（网络实发），forms=inferred（DOM 可发起），'
        + 'unverifiedPaths=unverified（静态线索）。JS 字符串里的路径不代表接口可用。',
    };
  }

  /** `browser_security_scope` — 状态/配置/停止。纯 Host 内存操作，无 CDP。 */
  securityScopeOp(args, exec) {    const action = String(args.action || '');
    if (action === 'status') {
      const store = this.#securityScope;
      return store === null
        ? { ok: true, active: false, configured: false, note: 'scope 未启用；普通 GUI 测试不受影响。set 建立边界后所有主动派发逐次校验。' }
        : { ok: true, configured: true, ...store.status() };
    }
    if (action === 'set') {
      assertKnownKeys(args, ['action', 'allowedOrigins', 'allowedPaths', 'maxRequests', 'maxConcurrent', 'maxRequestsPerSecond', 'timeWindowMs', 'mode', 'expectedConfigRevision'], 'security_scope.set');
      const store = this.#scopeStore();
      try {
        const config = store.configure({
          allowedOrigins: args.allowedOrigins,
          allowedPaths: args.allowedPaths,
          maxRequests: args.maxRequests,
          maxConcurrent: args.maxConcurrent,
          maxRequestsPerSecond: args.maxRequestsPerSecond,
          timeWindowMs: args.timeWindowMs,
          mode: args.mode,
        }, { expectedConfigRevision: args.expectedConfigRevision, actionId: exec?.meta?.actionId ?? null });
        // NOTE: `scopeConfigRevision`, not `configRevision` — the envelope merges `meta` over the
        // value, and `meta.configRevision` is the *plugin config* revision. A colliding field name
        // would hand callers the wrong CAS token (measured: exactly that bug).
        return { ok: true, configured: true, scopeConfigRevision: store.configRevision, config, note: 'scope 边界已生效：此后每次导航/请求派发前逐次校验（含重定向每一跳）。' };
      } catch (refusal) {
        throw new BrowserError(refusal.code, refusal.message, refusal.details ?? {});
      }
    }
    if (action === 'stop') {
      assertKnownKeys(args, ['action', 'reason'], 'security_scope.stop');
      const store = this.#securityScope;
      if (store === null) {
        return { ok: true, active: false, configured: false, note: 'scope 从未启用；无可停止对象。' };
      }
      const result = store.stop({ reason: args.reason ?? null, actionId: exec?.meta?.actionId ?? null });
      return { ok: true, configured: true, ...result, note: 'scope 已停止：0 次新派发；重新配置需新会话。' };
    }
    throw new BrowserError('SECURITY_SCOPE_INVALID', 'security_scope.action 不合法: ' + action, { allowed: ['status', 'set', 'stop'] });
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

  /* ---- Web T4 dynamic behaviour (M1: session / observe / analyze) ------------------------- */

  /**
   * Lazily load the pure core. Nothing else in the Host imports it: T1/T2/T3/P0 and the page
   * preview must keep working even when dynamic-t4.js is absent or broken, and a T4 call must
   * fail by name instead of surfacing INTERNAL.
   */
  async #dynamicLoadCore() {
    const state = this.dynamic;
    if (state.core) return state.core;
    if (!state.corePromise) {
      state.corePromise = import('./dynamic-t4.js').then((module) => {
        const required = ['DynamicFrameStore', 'DynamicEventLog', 'runMotionAssertions', 'normalizeDynamicEvent'];
        const missing = required.filter((name) => typeof module[name] !== 'function');
        if (missing.length) {
          throw new BrowserError('DYNAMIC_SOURCE_UNAVAILABLE', '动态核心 dynamic-t4.js 导出不完整', {
            reason: 'core-incomplete', missing,
          });
        }
        state.core = module;
        return module;
      }).catch((error) => {
        state.corePromise = null;
        if (error instanceof BrowserError) throw error;
        throw new BrowserError('DYNAMIC_SOURCE_UNAVAILABLE', '动态核心 dynamic-t4.js 不可用', { reason: 'core-unavailable' });
      });
    }
    return state.corePromise;
  }

  /** Capability report may state "core not loaded" for data it does not need. */
  #dynamicCoreLoaded() { return this.dynamic.core !== null; }

  /**
   * TOOL-P1-06: machine-readable assertion schema for browser_capabilities.dynamic.assertions.
   * Loading the pure core is a module import only (no page, no lease, no frame, no session); if the
   * core is missing/broken the capability report degrades to `assertions:null` plus a limitation
   * instead of turning a read-only capability probe into an error.
   */
  async dynamicAssertionSchema() {
    if (this.dynamic.core) return this.dynamic.core.MOTION_ASSERTION_SCHEMA ?? null;
    try {
      const core = await this.#dynamicLoadCore();
      return core.MOTION_ASSERTION_SCHEMA ?? null;
    } catch (error) {
      this.dynamic.assertionSchemaUnavailable = (error && error.code) || 'core-unavailable';
      return null;
    }
  }

  #dynamicTouch(operation, extra = {}) {
    const state = this.dynamic;
    const session = state.session;
    state.lastOperation = operation;
    state.observed = {
      observedAt: Date.now(),
      operation,
      dynamicSessionId: session ? session.dynamicSessionId : null,
      motionSessionId: session ? session.motionSessionId : null,
      source: session ? session.config.source : null,
      encoding: session ? session.config.encoding : null,
      frames: session ? session.counters.frames : 0,
      highWater: this.#dynamicHighWater(session),
      verdict: extra.verdict === undefined ? null : extra.verdict,
      integrity: session ? this.#dynamicIntegrity(session) : null,
      restoreStatus: session ? session.restoreStatus : null,
    };
  }

  #dynamicHighWater(session) {
    const frameHigh = session && session.frames && Number.isFinite(session.frames.highWater)
      ? session.frames.highWater
      : (session ? session.counters.frames : 0);
    const eventHigh = session && session.events && Number.isFinite(session.events.highWater)
      ? session.events.highWater
      : (session ? session.counters.events : 0);
    return {
      operation: eventHigh,
      visual: session && session.captureVisual ? frameHigh : null,
      network: session && session.networkSessionId ? (this.net.session && this.net.session.id === session.networkSessionId ? this.net.status().session.counters.seq : null) : null,
    };
  }

  #dynamicEvent(session, { domain, kind, phase = null, payload = {}, ts = null }) {
    const nowMono = dynamicMonoNow();
    const sourceTimestamp = ts && Number.isFinite(ts.sourceTimestamp) ? ts.sourceTimestamp : null;
    return {
      version: 1,
      dynamicSessionId: session.dynamicSessionId,
      domain, kind, phase,
      scopeId: this.scope.id,
      runtimeId: this.runtimeId,
      pageGeneration: this.page ? this.page.generation : null,
      documentEpoch: this.t2.documentEpoch,
      runGeneration: null,
      targetId: this.page ? this.page.targetId : null,
      cdpSessionId: null,
      documentFrameId: null,
      ts: {
        timelineMs: Math.max(0, Math.round((nowMono - session.startedMonoMs) * 1000) / 1000),
        sourceTimestamp,
        sourceClock: sourceTimestamp === null ? 'host-monotonic' : 'cdp-screencast-epoch-ms',
        receivedMonoMs: nowMono,
        wallMs: Date.now(),
        logicalMs: null,
        anchorId: null,
        uncertaintyMs: null,
        resolutionMs: null,
      },
      ids: { actionId: null, opId: null, frameId: null, traceIdHash: null, requestKey: null },
      sourceRef: {
        networkSessionId: session.networkSessionId, networkSeq: null,
        visualSessionId: session.motionSessionId, frameSeq: null,
      },
      provenance: {
        producer: 'host', sourceKind: 'runtime', adapterId: null, adapterVersion: null,
        trust: 'host-observed', evidenceIds: [], rawHash: null,
      },
      payload,
      incomplete: [],
      truncated: false,
    };
  }

  async #dynamicAppendEvent(session, spec) {
    if (!session.events) return null;
    try {
      const event = session.events.append(this.#dynamicEvent(session, spec));
      if (event && Number.isInteger(event.seq)) session.counters.events = Math.max(session.counters.events, event.seq);
      else session.counters.events += 1;
      return event || null;
    } catch {
      session.counters.sinkErrors += 1;
      return null;
    }
  }

  #dynamicMapping(metadata) {
    const meta = metadata && typeof metadata === 'object' ? metadata : {};
    const view = this.view;
    const outputWidth = Number.isFinite(Number(meta.deviceWidth)) && Number(meta.deviceWidth) > 0
      ? Number(meta.deviceWidth) : view.width;
    const outputHeight = Number.isFinite(Number(meta.deviceHeight)) && Number(meta.deviceHeight) > 0
      ? Number(meta.deviceHeight) : view.height;
    const scrollX = Number.isFinite(Number(meta.scrollOffsetX)) ? Number(meta.scrollOffsetX) : view.x;
    const scrollY = Number.isFinite(Number(meta.scrollOffsetY)) ? Number(meta.scrollOffsetY) : view.y;
    const pageScale = Number.isFinite(Number(meta.pageScaleFactor)) && Number(meta.pageScaleFactor) > 0
      ? Number(meta.pageScaleFactor) : 1;
    const cssPerPixel = 1 / pageScale;
    const cssWidth = Math.round(outputWidth * cssPerPixel);
    const cssHeight = Math.round(outputHeight * cssPerPixel);
    return {
      version: 1,
      space: 'canvas-css-px',
      // T4 geometry (contract §4.9): frozen per frame, never reconstructed at read time.
      viewport: { x: view.canvasX, y: view.canvasY, width: view.width, height: view.height },
      scroll: { x: scrollX, y: scrollY },
      canvasOffset: { x: view.canvasX - view.x, y: view.canvasY - view.y },
      deviceScaleFactor: 1,
      pageScaleFactor: pageScale,
      viewScale: view.scale,
      viewRevision: view.revision,
      documentEpoch: this.t2.documentEpoch,
      dimensions: { width: Math.round(outputWidth), height: Math.round(outputHeight) },
      offsetTop: Number.isFinite(Number(meta.offsetTop)) ? Number(meta.offsetTop) : 0,
      // T3-compatible projection so the shared pixel primitives can prove frame comparability
      // (vision-t3 `mappingCompatible`). originCss is the captured viewport's document origin;
      // cssPerPixel folds page zoom (deviceScaleFactor is fixed at 1 by the shared viewport).
      coordinateSpace: 'document-css-px',
      originCss: { x: scrollX, y: scrollY },
      cssPerPixel: { x: cssPerPixel, y: cssPerPixel },
      capturedCssRect: { x: scrollX, y: scrollY, width: cssWidth, height: cssHeight },
      imagePixels: { width: Math.round(outputWidth), height: Math.round(outputHeight) },
      visualViewport: { width: view.width, height: view.height, scale: pageScale },
    };
  }

  /**
   * Geometry/document segments (contract §4.9): a new segment starts when viewport size, scroll,
   * canvas offset, view revision or document epoch move. Segmentation is bounded (64); beyond that
   * the last segment keeps collecting and the truncation is reported, never silently dropped.
   */
  #dynamicSegmentFor(session, mapping) {
    const sig = [
      mapping.viewRevision, mapping.dimensions.width, mapping.dimensions.height,
      Math.round(mapping.scroll.x), Math.round(mapping.scroll.y),
      Math.round(mapping.canvasOffset.x), Math.round(mapping.canvasOffset.y),
      mapping.documentEpoch,
    ].join('|');
    const last = session.segments[session.segments.length - 1];
    if (last && last.signature === sig) return last.segmentId;
    if (session.segments.length >= 64) {
      session.segmentsTruncated = true;
      if (!session.issues.includes('segment-limit')) session.issues.push('segment-limit');
      last.toSeq = session.counters.frames;
      return last.segmentId;
    }
    session.segmentSeq += 1;
    const segment = {
      segmentId: 'seg_' + session.segmentSeq,
      fromSeq: session.counters.frames + 1,
      toSeq: null,
      frames: 0,
      signature: sig,
      viewRevision: mapping.viewRevision,
      documentEpoch: mapping.documentEpoch,
      scroll: { ...mapping.scroll },
      dimensions: { ...mapping.dimensions },
    };
    session.segments.push(segment);
    session.segmentById.set(segment.segmentId, segment);
    session.segmentId = segment.segmentId;
    return segment.segmentId;
  }

  /**
   * Screenshot-loop source (contract §4.5): one internal P0 PNG capture per tick, single-flight,
   * no backlog. A missed tick increments samplingFailures/gaps; begin/end monotonic instants are
   * recorded as the sampling interval and sourceTimestamp stays null (never receive-time-as-source).
   */
  #dynamicStartLoop(session) {
    const cdp = this.cdp;
    if (!cdp || cdp.closed) throw new BrowserError('DYNAMIC_SOURCE_UNAVAILABLE', 'screenshot-loop 需要已启动的页面', { reason: 'no-page' });
    const loop = {
      active: true,
      timer: null,
      inflight: false,
      missed: 0,
      intervalMs: session.config.sampleIntervalMs,
      cdp,
    };
    const tick = async () => {
      if (!loop.active || session.state !== 'running') return;
      if (this.cdp !== loop.cdp || loop.cdp.closed) {
        loop.active = false;
        if (loop.timer) clearInterval(loop.timer);
        return;
      }
      if (loop.inflight) {
        loop.missed += 1;
        session.counters.samplingFailures += 1;
        try { session.frames?.markSamplingFailure?.(); } catch { /* evidence only */ }
        return;
      }
      loop.inflight = true;
      const beginMonoMs = dynamicMonoNow();
      // TOOL-P1-03: the loop tick START is the measured sampling cadence (single-flight; a missed
      // tick is counted as a sampling failure and is not appended). Bounded to 240 samples.
      session.counters.samplingTicks += 1;
      session.samplingTrace.push(beginMonoMs);
      if (session.samplingTrace.length > DYNAMIC_INTERNAL.samplingTraceMax) {
        session.samplingTrace.shift();
        session.samplingTraceTruncated = true;
      }
      try {
        const shot = await loop.cdp.send('Page.captureScreenshot', { format: 'png' }, { timeoutMs: 5000 });
        const endMonoMs = dynamicMonoNow();
        const bytes = Buffer.from(String(shot.data || ''), 'base64');
        const info = inspectPng(bytes);
        if (!info || info.ok !== true) {
          session.counters.samplingFailures += 1;
          try { session.frames?.markSamplingFailure?.(); } catch { /* evidence only */ }
          return;
        }
        if (bytes.length > T4_LIMITS.maxFrameBytes || info.width * info.height > T4_LIMITS.maxFramePixels) {
          session.counters.dropped += 1;
          if (!session.issues.includes('frame-budget')) session.issues.push('frame-budget');
          return;
        }
        const mapping = this.#dynamicMapping({ deviceWidth: info.width, deviceHeight: info.height });
        const segmentId = this.#dynamicSegmentFor(session, mapping);
        const record = {
          sourceTimestamp: null,
          sourceClock: 'host-monotonic',
          receivedMonoMs: beginMonoMs,
          timelineMs: Math.max(0, Math.round((beginMonoMs - session.startedMonoMs) * 1000) / 1000),
          encoding: 'png',
          bytes,
          sha256: dynamicSha256(bytes),
          dimensions: { width: info.width, height: info.height },
          mapping,
          documentEpoch: this.t2.documentEpoch,
          segmentId,
          provenance: {
            producer: 'host', sourceKind: 'cdp-page-capture-screenshot', adapterId: null,
            adapterVersion: null, trust: 'cdp-observed', evidenceIds: [], rawHash: null,
          },
          incomplete: ['source-timestamp-missing'],
        };
        const sessionFrameSeq = ++session.counters.frames;
        void sessionFrameSeq;
        session.counters.bytes += bytes.length;
        const result = session.frames.addFrame(record) || {};
        if (result.ok === false) {
          session.counters.dropped += 1;
        } else {
          session.counters.framesStored += 1;
          if (Array.isArray(result.evicted)) session.counters.evicted += result.evicted.length;
          if (session.samples && result.frameId) {
            session.samples.set(result.frameId, { beginMonoMs, endMonoMs });
            if (session.samples.size > 32) {
              const oldest = session.samples.keys().next().value;
              session.samples.delete(oldest);
            }
          }
          const segment = session.segmentById.get(segmentId);
          if (segment && Number.isInteger(result.seq)) {
            segment.toSeq = result.seq;
            segment.frames = (segment.frames || 0) + 1;
          }
        }
      } catch (error) {
        session.counters.samplingFailures += 1;
        try { session.frames?.markSamplingFailure?.(); } catch { /* evidence only */ }
      } finally {
        loop.inflight = false;
      }
    };
    loop.timer = setInterval(() => { tick().catch(() => {}); }, session.config.sampleIntervalMs);
    if (loop.timer && typeof loop.timer.unref === 'function') loop.timer.unref();
    session.loop = loop;
  }

  /**
   * Called by the ONE screencast event branch, before `this.frames.accept()` overwrites the
   * preview latest-frame. It only copies the raw params into a bounded queue; decoding happens in
   * the core store (drained on a later turn), so the preview and the ACK never wait for it.
   */
  #dynamicSinkAccept(params, receivedMonoMs) {
    const sink = this.dynamic.sink;
    if (!sink || !sink.session || sink.session.state !== 'running') return;
    const session = sink.session;
    try {
      const metadata = params && params.metadata ? params.metadata : {};
      const base64 = typeof params?.data === 'string' ? params.data : '';
      const sourceTimestamp = dynamicSourceTimestamp(metadata);
      const bytes = Buffer.from(base64, 'base64');
      const mapping = this.#dynamicMapping(metadata);
      const segmentId = this.#dynamicSegmentFor(session, mapping);
      const width = mapping.dimensions.width;
      const height = mapping.dimensions.height;
      sink.frameSeq += 1;
      const reason = bytes.length === 0 ? 'empty-data'
        : bytes.length > T4_LIMITS.maxFrameBytes ? 'oversize'
        : width * height > T4_LIMITS.maxFramePixels ? 'pixels'
        : (sink.queue.length >= session.config.maxFrames || sink.queuedBytes + bytes.length > session.config.maxBytes) ? 'queue-full'
        : null;
      if (reason) {
        session.counters.dropped += 1;
        session.counters.frames += 1;
        sink.dropped += 1;
        if (!session.issues.includes(reason)) session.issues.push(reason);
        return;
      }
      if (sourceTimestamp === null) session.counters.missingSourceTimestamps += 1;
      const record = {
        // Exactly the fields the pure core accepts (`DynamicFrameStore.addFrame`): anything else is
        // rejected as DYNAMIC_INVALID_ARGUMENT and would silently become a sink error.
        sourceTimestamp,
        sourceClock: sourceTimestamp === null ? 'host-monotonic' : 'cdp-screencast-epoch-ms',
        receivedMonoMs,
        timelineMs: Math.max(0, Math.round((receivedMonoMs - session.startedMonoMs) * 1000) / 1000),
        encoding: 'jpeg',
        bytes,
        sha256: dynamicSha256(bytes),
        dimensions: { width, height },
        mapping,
        documentEpoch: this.t2.documentEpoch,
        segmentId,
        provenance: {
          producer: 'host', sourceKind: 'cdp-screencast', adapterId: null, adapterVersion: null,
          trust: 'cdp-observed', evidenceIds: [], rawHash: null,
        },
        incomplete: sourceTimestamp === null ? ['source-timestamp-missing'] : [],
      };
      sink.queue.push(record);
      sink.queuedBytes += bytes.length;
      this.#dynamicSinkSchedule(sink);
    } catch {
      session.counters.sinkErrors += 1;
    }
  }

  #dynamicSinkSchedule(sink) {
    if (sink.scheduled) return;
    sink.scheduled = true;
    setImmediate(() => {
      sink.scheduled = false;
      this.#dynamicSinkDrain(sink);
    });
  }

  /** Drain with a bounded per-turn budget: one slow JPEG decode must not stall the page queue. */
  #dynamicSinkDrain(sink, { all = false } = {}) {
    if (!sink || !sink.session) return;
    const session = sink.session;
    const startedAt = dynamicMonoNow();
    while (sink.queue.length > 0) {
      const record = sink.queue.shift();
      sink.queuedBytes = Math.max(0, sink.queuedBytes - record.bytes.length);
      session.counters.frames += 1;
      session.counters.bytes += record.bytes.length;
      if (!session.frames) { session.counters.sinkErrors += 1; continue; }
      try {
        const result = session.frames.addFrame(record) || {};
        if (result.ok === false) {
          session.counters.dropped += 1;
          const reason = result.reason || 'store-refused';
          if (!session.issues.includes(reason)) session.issues.push(reason);
        } else {
          session.counters.framesStored += 1;
          const evicted = Array.isArray(result.evicted) ? result.evicted : (Number.isFinite(result.evicted) ? result.evicted : 0);
          if (Array.isArray(result.evicted)) session.counters.evicted += result.evicted.length;
          else if (typeof evicted === 'number' && evicted > 0) session.counters.evicted += evicted;
          if (Number.isInteger(result.seq)) {
            const segment = session.segmentById.get(record.segmentId);
            if (segment) {
              segment.toSeq = result.seq;
              segment.frames = (segment.frames || 0) + 1;
            }
          }
        }
      } catch (error) {
        session.counters.sinkErrors += 1;
        if (!session.issues.includes('sink-error')) session.issues.push('sink-error');
      }
      if (!all && dynamicMonoNow() - startedAt > 8) break;
    }
    if (sink.queue.length > 0) this.#dynamicSinkSchedule(sink);
    else if (sink.drainedResolve) { const resolve = sink.drainedResolve; sink.drainedResolve = null; resolve(); }
  }

  #dynamicSinkFlush(sink) {
    if (!sink) return Promise.resolve();
    if (sink.queue.length === 0) return Promise.resolve();
    return new Promise((resolve) => {
      sink.drainedResolve = resolve;
      this.#dynamicSinkDrain(sink, { all: true });
      if (sink.queue.length === 0 && sink.drainedResolve) { const done = sink.drainedResolve; sink.drainedResolve = null; done(); }
    });
  }

  /** The single ACK branch notifies the sink's store; T4 never sends a screencast ACK itself. */
  #dynamicNoteAck(ok) {
    const session = (this.dynamic.sink && this.dynamic.sink.session) || this.dynamic.session || this.dynamic.records[0] || null;
    if (!session) return;
    session.counters.ackAttempts += 1;
    if (ok === false) session.counters.ackFailures += 1;
    try { if (session.frames && typeof session.frames.recordAck === 'function') session.frames.recordAck(ok === true); } catch { /* evidence only */ }
  }

  #dynamicCreateRecord(name, config) {
    let motionSessionId = null;
    if (config.captureVisual) motionSessionId = newMotionSessionId();
    const record = {
      dynamicSessionId: newDynamicSessionId(),
      motionSessionId,
      name,
      networkSessionId: config.networkSessionId,
      captureVisual: config.captureVisual,
      config,
      state: 'running',
      startedAt: Date.now(),
      startedMonoMs: dynamicMonoNow(),
      deadlineMs: 0,
      cumulativeMs: config.durationMs,
      stoppedAt: null,
      stoppedMonoMs: null,
      stopReason: null,
      documentEpoch: this.t2.documentEpoch,
      pageGeneration: this.page ? this.page.generation : null,
      runtimeId: this.runtimeId,
      frames: null,
      events: null,
      counters: {
        frames: 0, framesStored: 0, events: 0, bytes: 0, dropped: 0, evicted: 0,
        ackAttempts: 0, ackFailures: 0, gaps: 0, sinkErrors: 0, decodeFailures: 0,
        // TOOL-P1-03 sampling counters: initialized so `+= 1` never turns into NaN.
        samplingTicks: 0, samplingFailures: 0, missingSourceTimestamps: 0,
        // observe(region) crop-on-delivery accounting (0 on the encoded-only path).
        cropDecodes: 0, cropFailures: 0,
      },
      issues: [],
      segments: [],
      segmentById: new Map(),
      segmentsTruncated: false,
      segmentId: 'seg_1',
      segmentSeq: 0,
      imageCache: new Map(),
      imageBytes: 0,
      samples: new Map(),
      // TOOL-P1-03: bounded loop-tick starts (screenshot-loop measured cadence) and a truncation flag.
      samplingTrace: [],
      samplingTraceTruncated: false,
      // Host-observed page action records for the actionId -> page opId bridge (bounded).
      hostActions: [],
      // Page-declared snapshots are read-only; every projection is tagged page-declared.
      pageBridge: { anchors: [], lastAt: null, sourceUnavailable: 0, domVerified: 0 },
      retained: true,
      restoreStatus: { status: 'not-needed', attempted: [], restored: [], failed: [], conflicts: [], lastObserved: [] },
      timer: null,
      highWater: { operation: null, visual: null, network: null },
    };
    record.deadlineMs = record.startedAt + config.durationMs;
    return record;
  }

  /**
   * TOOL-P1-03 sampling truth projection (session start/status/extend/stop, observe and
   * evidence.dynamic all share this block). Values are measured, never inferred from the
   * requested interval:
   *  - screenshot-loop: stored frame receivedMonoMs (the loop tick start frozen on each frame);
   *  - screencast: stored frame timelineMs intervals (damage-driven, uneven);
   *  - captureVisual:false: no sampling at all (`mechanism:'network-only'`).
   * Both visual mechanisms use the SAME stored frame window that browser_motion_observe returns,
   * so sampling.measured can be cross-checked value-for-value against observe frames.
   * Missing data is reported as null plus an explicit limitation, never as 0.
   */
  #dynamicSamplingView(session) {
    if (!session) return null;
    const config = session.config || {};
    const countersIn = session.counters || {};
    const captureVisual = config.captureVisual !== false;
    const mechanism = !captureVisual
      ? 'network-only'
      : (config.source === 'screenshot-loop' ? 'screenshot-loop' : 'screencast');
    const cadence = mechanism === 'screenshot-loop'
      ? 'host-scheduled'
      : (mechanism === 'screencast' ? 'damage-driven' : 'none');
    const limitations = [];
    let times = [];
    let from = null;
    let framesConsidered = 0;
    // Both visual mechanisms read the SAME stored frame set that browser_motion_observe returns,
    // so `sampling.measured` can be cross-checked value-for-value against observe frames:
    //  - screenshot-loop: receivedMonoMs (the loop tick start recorded on the frame);
    //  - screencast: timelineMs (host receive mapping).
    // session.samplingTrace (loop tick starts) is still recorded for internal/debug use, but it is
    // NOT the measured basis: failed/evicted ticks would otherwise make the medians disagree.
    if (mechanism === 'screenshot-loop' || mechanism === 'screencast') {
      const loop = mechanism === 'screenshot-loop';
      from = loop ? 'loop-tick-start' : 'frame-timeline';
      const timeField = loop ? 'receivedMonoMs' : 'timelineMs';
      try {
        const store = session.frames;
        const highWater = store && Number.isInteger(store.highWater) ? store.highWater : 0;
        const sinceSeq = Math.max(0, highWater - DYNAMIC_INTERNAL.samplingTraceMax);
        const frames = store
          ? this.#dynamicFramesOf(session, { sinceSeq, limit: DYNAMIC_INTERNAL.samplingTraceMax })
          : [];
        framesConsidered = frames.length;
        let missingTime = 0;
        for (const frame of frames) {
          if (Number.isFinite(frame[timeField])) times.push(frame[timeField]);
          else missingTime += 1;
        }
        if (missingTime > 0) limitations.push(loop ? 'frames-missing-tick-start' : 'frames-missing-timeline');
        if (highWater > DYNAMIC_INTERNAL.samplingTraceMax) {
          limitations.push('sampling-window-bounded:' + DYNAMIC_INTERNAL.samplingTraceMax);
        }
        if (frames.length === 0) limitations.push('no-sampling-samples');
      } catch {
        limitations.push('sampling-frames-unavailable');
      }
    } else {
      limitations.push('no-visual-capture');
    }
    const stats = dynamicIntervalStats(times);
    if (stats.intervals === 0 && mechanism !== 'network-only') limitations.push('interval-count-zero');
    const requestedIntervalMs = mechanism === 'screenshot-loop' && Number.isFinite(config.sampleIntervalMs)
      ? config.sampleIntervalMs
      : null;
    return {
      version: 1,
      mechanism,
      cadence,
      requested: {
        intervalMs: requestedIntervalMs,
        source: mechanism === 'screenshot-loop'
          ? 'setInterval(host)'
          : (mechanism === 'screencast' ? 'cdp-screencast(damage-driven)' : null),
      },
      measured: {
        frames: stats.frames,
        intervals: stats.intervals,
        p50Ms: stats.p50Ms,
        p95Ms: stats.p95Ms,
        minMs: stats.minMs,
        maxMs: stats.maxMs,
        meanMs: stats.meanMs,
        windowMs: stats.windowMs,
        effectiveFps: stats.effectiveFps,
        from,
      },
      counters: {
        sampled: mechanism === 'screenshot-loop'
          ? (Number.isFinite(countersIn.samplingTicks) ? countersIn.samplingTicks : 0)
          : (Number.isFinite(countersIn.frames) ? countersIn.frames : 0),
        dropped: Number.isFinite(countersIn.dropped) ? countersIn.dropped : 0,
        evicted: Number.isFinite(countersIn.evicted) ? countersIn.evicted : 0,
        samplingFailures: Number.isFinite(countersIn.samplingFailures) ? countersIn.samplingFailures : 0,
      },
      framesConsidered,
      limitations: [...new Set(limitations)],
    };
  }

  #dynamicSessionView(session) {
    if (!session) return null;
    const config = session.config;
    return {
      dynamicSessionId: session.dynamicSessionId,
      motionSessionId: session.motionSessionId,
      networkSessionId: session.networkSessionId,
      name: session.name,
      state: session.state,
      startedAt: session.startedAt,
      stoppedAt: session.stoppedAt,
      stopReason: session.stopReason,
      deadlineMs: Number.isFinite(session.deadlineMs) ? session.deadlineMs : null,
      cumulativeMs: Number.isFinite(session.cumulativeMs) ? session.cumulativeMs : null,
      config: {
        captureVisual: config.captureVisual,
        source: config.source,
        encoding: config.encoding,
        durationMs: config.durationMs,
        maxFrames: config.maxFrames,
        maxBytes: config.maxBytes,
        region: config.region,
        scale: config.scale,
        sampleIntervalMs: config.sampleIntervalMs,
        resolvedViewScale: config.resolvedViewScale,
      },
      highWater: this.#dynamicHighWater(session),
      counters: {
        frames: session.counters.frames,
        events: session.counters.events,
        bytes: session.counters.bytes,
        dropped: session.counters.dropped,
        evicted: session.counters.evicted,
        ackFailures: session.counters.ackFailures,
        samplingTicks: Number.isFinite(session.counters.samplingTicks) ? session.counters.samplingTicks : 0,
        samplingFailures: Number.isFinite(session.counters.samplingFailures) ? session.counters.samplingFailures : 0,
      },
      // TOOL-P1-03: measured sampling (mechanism/cadence/requested/measured/counters/limitations).
      sampling: this.#dynamicSamplingView(session),
      retained: session.retained,
    };
  }

  #dynamicSummary(session) {
    const view = this.#dynamicSessionView(session);
    if (!view) return null;
    return {
      dynamicSessionId: view.dynamicSessionId,
      motionSessionId: view.motionSessionId,
      networkSessionId: view.networkSessionId,
      name: view.name,
      state: view.state,
      startedAt: view.startedAt,
      stoppedAt: view.stoppedAt,
      retained: view.retained,
      counters: view.counters,
      sampling: view.sampling,
    };
  }

  #dynamicIntegrity(session) {
    if (!session) {
      return {
        complete: false, captured: 0, retained: 0, dropped: 0, evicted: 0, truncated: false,
        ackFailures: 0, gaps: 0, issues: ['no-session'],
        coverage: {
          source: null, segments: 0, maxAdjacentIntervalMs: null, missingSourceTimestamps: 0,
          samplingFailures: 0, decodeFailures: 0, adapters: 0, unknownSourceDrops: null,
        },
      };
    }
    let storeIntegrity = null;
    try { if (session.frames && typeof session.frames.integrity === 'function') storeIntegrity = session.frames.integrity(); } catch { storeIntegrity = null; }
    const base = storeIntegrity && typeof storeIntegrity === 'object' ? storeIntegrity : {};
    const captured = Number.isFinite(base.captured) ? base.captured : session.counters.framesStored;
    const dropped = Number.isFinite(base.dropped) ? base.dropped : session.counters.dropped;
    const evicted = Number.isFinite(base.evicted) ? base.evicted : session.counters.evicted;
    const ackFailures = Number.isFinite(base.ackFailures) ? base.ackFailures : session.counters.ackFailures;
    const gaps = Number.isFinite(base.gaps) ? base.gaps : session.counters.gaps;
    const coreCoverage = base.coverage && typeof base.coverage === 'object' ? base.coverage : {};
    const coverage = {
      source: session.config.source,
      segments: Array.isArray(coreCoverage.segments) ? coreCoverage.segments.length : session.segments.length,
      maxAdjacentIntervalMs: Number.isFinite(coreCoverage.maxAdjacentIntervalMs) ? coreCoverage.maxAdjacentIntervalMs : null,
      missingSourceTimestamps: Number.isFinite(coreCoverage.missingSourceTimestamps) ? coreCoverage.missingSourceTimestamps : (session.counters.missingSourceTimestamps || 0),
      samplingFailures: Number.isFinite(coreCoverage.samplingFailures) ? coreCoverage.samplingFailures : (session.counters.samplingFailures || 0),
      decodeFailures: Number.isFinite(coreCoverage.decodeFailures) ? coreCoverage.decodeFailures : session.counters.decodeFailures,
      adapters: Array.isArray(coreCoverage.adapters) ? coreCoverage.adapters.length : 0,
      unknownSourceDrops: null,
    };
    // Conditional hint: only while the window is still empty AND either stopped or >500ms old.
    // Once any frame is captured the hint must disappear (no sticky false signal).
    const emptyWindow = captured === 0
      && session.config && session.config.source === 'screencast'
      && (session.state !== 'running' || (Date.now() - session.startedAt) >= 500);
    if (emptyWindow) {
      coverage.note = 'no-damage-frames';
      if (!session.issues.includes('no-damage-frames')) session.issues.push('no-damage-frames');
    } else {
      delete coverage.note;
      const index = session.issues.indexOf('no-damage-frames');
      if (index !== -1) session.issues.splice(index, 1);
    }
    return {
      complete: session.state !== 'running' && base.complete === true && session.counters.sinkErrors === 0,
      captured,
      retained: Number.isFinite(base.retained) ? base.retained : captured,
      dropped,
      evicted,
      truncated: base.truncated === true,
      ackFailures,
      gaps,
      issues: Array.isArray(base.issues) && base.issues.length ? [...base.issues, ...session.issues] : [...session.issues],
      coverage,
    };
  }

  #dynamicControlEvidence(session) {
    if (!session) return null;
    return {
      requested: null,
      applied: [],
      failedIndex: null,
      fields: [],
      restoreStatus: session.restoreStatus,
    };
  }

  #dynamicEvidence(operation, session, { verdict = null, incomplete = [] } = {}) {
    return {
      dynamic: {
        version: 1,
        operation,
        provenance: {
          actionId: null,
          scopeId: this.scope.id,
          runtimeId: this.runtimeId,
          pageGeneration: this.page ? this.page.generation : null,
          documentEpoch: this.t2.documentEpoch,
          algorithmVersion: DYNAMIC_ALGORITHM_VERSION,
        },
        sessionIds: {
          dynamicSessionId: session ? session.dynamicSessionId : null,
          motionSessionId: session ? session.motionSessionId : null,
          networkSessionId: session ? session.networkSessionId : null,
        },
        highWater: this.#dynamicHighWater(session),
        clockAnchors: [],
        integrity: this.#dynamicIntegrity(session),
        // TOOL-P1-03: evidence carries the same measured sampling block (never requested-as-truth).
        sampling: this.#dynamicSamplingView(session),
        control: this.#dynamicControlEvidence(session),
        redaction: { applied: ['payload:pixels'], rules: [] },
        incomplete: [...incomplete],
        truncated: false,
        ...(verdict ? { verdict } : {}),
      },
    };
  }

  /** Error-path evidence (contract §3): details.evidence.dynamic, never a second error shape. */
  dynamicErrorEvidence(operation) {
    const block = this.#dynamicEvidence(operation, this.dynamic.session);
    return block.dynamic;
  }

  async #dynamicStart(sessionRecord, signal) {
    // Visual start is a page operation (the caller already entered the Runtime queue); the page is
    // ensured here so `start` returns immediately once the sink is attached.
    await this.ensure(signal);
    const core = await this.#dynamicLoadCore();
    const limits = { ...T4_LIMITS, maxFrames: sessionRecord.config.maxFrames, maxBytes: sessionRecord.config.maxBytes };
    const now = () => dynamicMonoNow();
    sessionRecord.frames = new core.DynamicFrameStore({
      scopeId: this.scope.id, dynamicSessionId: sessionRecord.dynamicSessionId, now, limits,
    });
    sessionRecord.events = new core.DynamicEventLog({
      scopeId: this.scope.id, dynamicSessionId: sessionRecord.dynamicSessionId, now, limits,
    });
    sessionRecord.documentEpoch = this.t2.documentEpoch;
    sessionRecord.pageGeneration = this.page ? this.page.generation : null;
    if (sessionRecord.config.source === 'screenshot-loop') {
      // PNG precise source: a single-flight bounded screenshot loop. No screencast sink is attached
      // (the preview stream stays exactly as it was); every sample carries begin/end monotonic
      // instants and sourceTimestamp=null (captureScreenshot exposes no presentation time).
      this.#dynamicStartLoop(sessionRecord);
    } else {
      const sink = {
        applied: true, session: sessionRecord, queue: [], queuedBytes: 0, scheduled: false,
        frameSeq: 0, dropped: 0, drainedResolve: null,
      };
      sessionRecord.sink = sink;
      this.dynamic.sink = sink;
    }
    this.dynamic.session = sessionRecord;
    this.dynamic.records = [sessionRecord, ...this.dynamic.records].slice(0, T4_LIMITS.retainedSessions);
    sessionRecord.timer = setTimeout(() => { this.#dynamicAutoStop(sessionRecord, 'duration'); }, sessionRecord.config.durationMs);
    if (sessionRecord.timer && typeof sessionRecord.timer.unref === 'function') sessionRecord.timer.unref();
    await this.#dynamicAppendEvent(sessionRecord, {
      domain: 'operation', kind: 'session.start', phase: 'end',
      payload: {
        source: sessionRecord.config.source, encoding: sessionRecord.config.encoding,
        durationMs: sessionRecord.config.durationMs, maxFrames: sessionRecord.config.maxFrames,
        previewScreencastReused: true,
      },
    });
    return sessionRecord;
  }

  async #dynamicAutoStop(session, reason) {
    if (!session || session.state !== 'running') return;
    try { await this.dynamicAutoStop({ reason }); } catch { /* best effort */ }
  }

  /**
   * Host-memory stop used by the duration timer: it only detaches the sink and flushes what was
   * already accepted. It never enters the page queue and never stops the preview screencast.
   */
  async dynamicAutoStop({ reason = 'duration' } = {}) {
    const session = this.dynamic.session;
    if (!session || session.state !== 'running') return null;
    await this.#dynamicFinalRestore(session, reason);
    if (session.dynamicSessionId) await this.#dynamicDetachSink(session, reason);
    this.dynamic.session = null;
    return session;
  }

  async #dynamicDetachSink(session, reason) {
    if (!session) return;
    if (session.loop) {
      session.loop.active = false;
      if (session.loop.timer) clearInterval(session.loop.timer);
      session.loop = null;
    }
    const sink = session.sink;
    if (sink) {
      try { await this.#dynamicSinkFlush(sink); } catch { /* evidence only */ }
      session.sink = null;
      if (this.dynamic.sink === sink) this.dynamic.sink = null;
    }
    if (session.timer) { clearTimeout(session.timer); session.timer = null; }
    session.state = 'stopped';
    session.stoppedAt = Date.now();
    session.stoppedMonoMs = dynamicMonoNow();
    session.stopReason = reason;
    if (session.frames && session.frames.integrity) {
      try {
        const integrity = session.frames.integrity();
        if (Number.isFinite(integrity?.coverage?.decodeFailures)) session.counters.decodeFailures = integrity.coverage.decodeFailures;
      } catch { /* evidence only */ }
    }
    await this.#dynamicAppendEvent(session, {
      domain: 'operation', kind: 'session.stop', phase: 'end',
      payload: {
        reason,
        cumulativeMs: session.cumulativeMs,
        deadlineMs: session.deadlineMs,
        frames: session.counters.framesStored,
        dropped: session.counters.dropped,
        evicted: session.counters.evicted,
        ackFailures: session.counters.ackFailures,
        restoreStatus: session.restoreStatus,
      },
    });
  }

  /** `browser_dynamic_session` (contract §2.1 / §3.1). */
  async dynamicSession(args, exec, signal) {
    assertDynamicKeys(args, ['action', 'name', 'config', 'durationMs'], 'dynamic_session');
    const action = String(args.action || '');
    if (!DYNAMIC_SESSION_ACTIONS.includes(action)) {
      throw new BrowserError('DYNAMIC_INVALID_ARGUMENT', 'session.action 不合法', { field: 'action', allowed: [...DYNAMIC_SESSION_ACTIONS] });
    }
    if (args.name !== undefined && args.name !== null
      && (typeof args.name !== 'string' || args.name === '' || Buffer.byteLength(args.name, 'utf8') > 64)) {
      throw new BrowserError('DYNAMIC_INVALID_ARGUMENT', 'name 必须是 1–64 字节的字符串', { field: 'name' });
    }
    if (action !== 'start' && args.name !== undefined) {
      throw new BrowserError('DYNAMIC_INVALID_ARGUMENT', 'name 只在 start 生效', { field: 'name' });
    }
    if (action !== 'start' && args.config !== undefined) {
      throw new BrowserError('DYNAMIC_INVALID_ARGUMENT', 'config 只在 start 生效', { field: 'config' });
    }
    if (action !== 'extend' && args.durationMs !== undefined) {
      throw new BrowserError('DYNAMIC_INVALID_ARGUMENT', 'durationMs 只在 extend 生效', { field: 'durationMs' });
    }
    this.#dynamicTouch('session.' + action);
    if (action === 'start') {
      const config = normalizeDynamicConfig(args.config || {}, {
        viewScale: this.view.scale,
        activeEncoding: 'jpeg',
      });
      const name = args.name || 'default';
      const active = this.dynamic.session;
      if (active && active.state === 'running') {
        if (active.name === name && dynamicConfigKey(active.config) === dynamicConfigKey(config)) {
          return {
            ok: true, changed: false, idempotent: true,
            session: this.#dynamicSessionView(active),
            sessions: this.dynamic.records.map((record) => this.#dynamicSummary(record)).filter(Boolean),
            limits: { ...T4_LIMITS },
            integrity: this.#dynamicIntegrity(active),
            restoreStatus: active.restoreStatus,
            evidence: this.#dynamicEvidence('session.start', active),
          };
        }
        throw new BrowserError('DYNAMIC_SESSION_ACTIVE', '本 scope 已有活动的动态会话', {
          activeDynamicSessionId: active.dynamicSessionId, activeName: active.name,
        });
      }
      if (!config.captureVisual) {
        // Pure network correlation view: Host memory only — no page, no lease, no P0 start/stop.
        const networkSession = this.net.session;
        if (!networkSession || networkSession.id !== config.networkSessionId) {
          throw new BrowserError('DYNAMIC_SESSION_NOT_FOUND', 'networkSessionId 不是本 scope 已有的 P0 会话', {
            networkSessionId: config.networkSessionId,
          });
        }
        const record = this.#dynamicCreateRecord(name, config);
        record.state = 'running';
        record.frames = null;
        record.events = null;
        this.dynamic.session = record;
        this.dynamic.records = [record, ...this.dynamic.records].slice(0, T4_LIMITS.retainedSessions);
        record.timer = setTimeout(() => { this.#dynamicAutoStop(record, 'duration'); }, config.durationMs);
        if (record.timer && typeof record.timer.unref === 'function') record.timer.unref();
        return {
          ok: true, changed: true,
          session: this.#dynamicSessionView(record),
          sessions: this.dynamic.records.map((item) => this.#dynamicSummary(item)).filter(Boolean),
          limits: { ...T4_LIMITS },
          integrity: this.#dynamicIntegrity(record),
          restoreStatus: record.restoreStatus,
          evidence: this.#dynamicEvidence('session.start', record),
        };
      }
      if (config.networkSessionId) {
        const networkSession = this.net.session;
        if (!networkSession || networkSession.id !== config.networkSessionId) {
          throw new BrowserError('DYNAMIC_SESSION_NOT_FOUND', 'networkSessionId 不是本 scope 已有的 P0 会话', {
            networkSessionId: config.networkSessionId,
          });
        }
      }
      const record = this.#dynamicCreateRecord(name, config);
      const started = await this.#dynamicStart(record, signal);
      return {
        ok: true, changed: true,
        session: this.#dynamicSessionView(started),
        sessions: this.dynamic.records.map((item) => this.#dynamicSummary(item)).filter(Boolean),
        limits: { ...T4_LIMITS },
        integrity: this.#dynamicIntegrity(started),
        restoreStatus: started.restoreStatus,
        evidence: this.#dynamicEvidence('session.start', started),
      };
    }
    if (action === 'extend') {
      // Pure Host-memory renewal: no ensure, no CDP, no page action, no sink re-attach, no lease.
      const session = this.dynamic.session;
      if (!session || session.state !== 'running') {
        throw new BrowserError('DYNAMIC_SESSION_NOT_ACTIVE', '当前会话不在活动窗口，无法续约', {
          reason: 'not-running',
          state: session ? session.state : null,
          dynamicSessionId: session ? session.dynamicSessionId : null,
        });
      }
      if (args.durationMs === undefined) {
        throw new BrowserError('DYNAMIC_INVALID_ARGUMENT', 'extend 必须给 durationMs', { field: 'durationMs' });
      }
      const extendMs = dynamicInteger(args.durationMs, 'durationMs', 1, T4_LIMITS.maxSessionExtendMs);
      const cumulativeMs = session.cumulativeMs + extendMs;
      if (cumulativeMs > T4_LIMITS.sessionCapMs) {
        throw new BrowserError('DYNAMIC_LIMIT_EXCEEDED', '会话累计时长超过上限', {
          limit: 'sessionCapMs', max: T4_LIMITS.sessionCapMs, actual: cumulativeMs,
        });
      }
      const previousDeadlineMs = session.deadlineMs;
      if (session.timer) { clearTimeout(session.timer); session.timer = null; }
      session.cumulativeMs = cumulativeMs;
      session.deadlineMs = previousDeadlineMs + extendMs;
      const delayMs = Math.max(0, session.deadlineMs - Date.now());
      session.timer = setTimeout(() => { this.#dynamicAutoStop(session, 'duration'); }, delayMs);
      if (session.timer && typeof session.timer.unref === 'function') session.timer.unref();
      await this.#dynamicAppendEvent(session, {
        domain: 'operation', kind: 'session.extend', phase: 'end',
        payload: {
          extendMs,
          previousDeadlineMs,
          newDeadlineMs: session.deadlineMs,
          cumulativeMs,
        },
      });
      this.#dynamicTouch('session.extend');
      return {
        ok: true, changed: true, extended: true,
        session: this.#dynamicSessionView(session),
        sessions: this.dynamic.records.map((item) => this.#dynamicSummary(item)).filter(Boolean),
        limits: { ...T4_LIMITS },
        integrity: this.#dynamicIntegrity(session),
        restoreStatus: session.restoreStatus,
        evidence: this.#dynamicEvidence('session.extend', session),
      };
    }
    if (action === 'status') {
      const session = this.dynamic.session;
      const latest = session || this.dynamic.records[0] || null;
      return {
        ok: true, changed: false,
        session: session ? this.#dynamicSessionView(session) : null,
        sessions: this.dynamic.records.map((item) => this.#dynamicSummary(item)).filter(Boolean),
        limits: { ...T4_LIMITS },
        integrity: session ? this.#dynamicIntegrity(session) : null,
        restoreStatus: latest ? latest.restoreStatus : { status: 'not-needed', attempted: [], restored: [], failed: [], conflicts: [], lastObserved: [] },
        evidence: this.#dynamicEvidence('session.status', session),
      };
    }
    if (action === 'stop') {
      const session = this.dynamic.session;
      // Explicit stop covers EVERY unfinished control in this scope (retained included) — not only
      // the active session, and never skipped just because a session's state is already stopped.
      const restores = await this.#dynamicRestoreAll('stop');
      const restoreStatus = this.#dynamicAggregateRestore(restores);
      if (!session) {
        return {
          ok: true, changed: false, session: null,
          sessions: this.dynamic.records.map((item) => this.#dynamicSummary(item)).filter(Boolean),
          limits: { ...T4_LIMITS }, integrity: null, restores,
          restoreStatus,
          evidence: this.#dynamicEvidence('session.stop', null),
        };
      }
      await this.#dynamicDetachSink(session, 'stop');
      this.dynamic.session = null;
      return {
        ok: true, changed: true,
        session: this.#dynamicSessionView(session),
        sessions: this.dynamic.records.map((item) => this.#dynamicSummary(item)).filter(Boolean),
        limits: { ...T4_LIMITS },
        integrity: this.#dynamicIntegrity(session),
        restores,
        restoreStatus,
        evidence: this.#dynamicEvidence('session.stop', session),
      };
    }
    // reset: BEST-EFFORT restore every unfinished control obligation in this scope BEFORE clearing
    // any record. A failed/partial restore aborts the cleanup and preserves identity/before/
    // lastWritten/token; conflicts alone are reported, never overwritten.
    const restores = await this.#dynamicRestoreAll('reset');
    const restoreStatus = this.#dynamicAggregateRestore(restores);
    const failedRestore = restoreStatus.status === 'failed' || restoreStatus.status === 'partial';
    if (failedRestore || (restoreStatus.status === 'conflict')) {
      const code = failedRestore ? 'DYNAMIC_RESTORE_FAILED' : 'DYNAMIC_CONTROL_CONFLICT';
      const error = new BrowserError(code, failedRestore
        ? 'reset 前控制恢复失败，已保留未结会话与控制身份'
        : 'reset 前控制恢复遇到外部改动冲突，未覆盖新状态', {
        restoreStatus, restores, cleared: 0, resetCompleted: false,
        evidence: { dynamic: this.dynamicErrorEvidence('session.reset') },
      });
      throw error;
    }
    const active = this.dynamic.session;
    if (active) await this.#dynamicDetachSink(active, 'reset');
    for (const record of this.dynamic.records) {
      record.retained = false;
      record.state = 'stopped';
      try { if (record.frames) record.frames.dispose(); } catch { /* best effort */ }
      try { if (record.events) record.events.dispose(); } catch { /* best effort */ }
      record.frames = null;
      record.events = null;
      record.imageCache.clear();
      record.imageBytes = 0;
    }
    const cleared = this.dynamic.records.length;
    this.dynamic.session = null;
    this.dynamic.records = [];
    this.dynamic.conflicts = [];
    return {
      ok: true, changed: cleared > 0, reset: true, cleared, resetCompleted: true,
      session: null, sessions: [], limits: { ...T4_LIMITS }, integrity: null,
      restores, restoreStatus,
      evidence: this.#dynamicEvidence('session.reset', null, { incomplete: cleared > 0 ? ['records-dropped'] : [] }),
    };
  }

  #dynamicSessionFor(motionSessionId) {
    const id = String(motionSessionId);
    const candidates = [this.dynamic.session, ...this.dynamic.records].filter(Boolean);
    for (const record of candidates) {
      if (record.motionSessionId && record.motionSessionId === id && record.retained) return record;
    }
    return null;
  }

  /**
   * Bounded frame read. `DynamicFrameStore.listFrames` caps one page at 200 rows, so analysis pages
   * by seq itself (never an unbounded read). Direct `frameIds` reads surface NOT_FOUND unchanged.
   */
  #dynamicFramesOf(session, { frameIds = null, window = null, sinceSeq = null, limit = null } = {}) {
    const store = session.frames;
    if (!store) return [];
    try {
      if (frameIds) return store.listFrames({ frameIds }).frames;
      const maxFrames = Math.min(limit || T4_LIMITS.maxFramesHard, T4_LIMITS.maxFramesHard);
      const out = [];
      let after = Number.isInteger(sinceSeq) ? sinceSeq : 0;
      let guard = 0;
      while (out.length < maxFrames && guard < 6) {
        const wanted = Math.min(200, maxFrames - out.length);
        if (wanted <= 0) break;
        const page = store.listFrames({ sinceSeq: after, window, limit: wanted });
        const frames = Array.isArray(page.frames) ? page.frames : [];
        out.push(...frames);
        if (!page.truncated || frames.length === 0) break;
        const lastSeq = frames[frames.length - 1].seq;
        if (!Number.isInteger(lastSeq) || lastSeq <= after) break;
        after = lastSeq;
        guard += 1;
      }
      const seen = new Set();
      return out.filter((frame) => {
        if (seen.has(frame.frameId)) return false;
        seen.add(frame.frameId);
        return true;
      });
    } catch (error) {
      // The core already speaks the DYNAMIC_* taxonomy (input/scope/budget). Never rewrite an
      // argument refusal into NOT_FOUND: that would hide a real caller mistake as a missing frame.
      throw asBrowserError(error);
    }
  }

  #dynamicFrameMeta(session, frame) {
    // The core's `frameMeta` is the canonical pure-JSON projection (no Buffer, no rgba). The Host
    // only adds delivery facts (`imageRef`, `image`, `sample`, `incomplete`) and the real source
    // name; it never re-derives hashes/dimensions on its own.
    const core = this.dynamic.core;
    if (core && typeof core.frameMeta === 'function') {
      try {
        const meta = core.frameMeta(frame);
        return {
          ...meta,
          source: session.config.source,
          dimensions: meta.dimensions || { width: null, height: null },
          imageRef: { frameId: meta.frameId, sha256: meta.sha256 },
          image: null,
          sample: frame.sample || (session.samples ? session.samples.get(frame.frameId) : null) || null,
          incomplete: Array.isArray(frame.incomplete) ? [...frame.incomplete] : [],
          decodeFailed: meta.decode?.failed === true,
        };
      } catch { /* fall through to the defensive Host projection */ }
    }
    const encoding = frame.encoding === 'png' || frame.encoding === 'jpeg' ? frame.encoding : session.config.encoding;
    const dimensions = frame.dimensions && Number.isFinite(frame.dimensions.width)
      ? { width: frame.dimensions.width, height: frame.dimensions.height }
      : { width: null, height: null };
    return {
      frameId: frame.frameId,
      seq: frame.seq,
      segmentId: frame.segmentId === undefined ? null : frame.segmentId,
      source: frame.source || session.config.source,
      sourceTimestamp: frame.sourceTimestamp === undefined ? null : frame.sourceTimestamp,
      receivedMonoMs: frame.receivedMonoMs,
      encoding,
      sha256: frame.sha256 || null,
      rgbaSha256: frame.rgbaSha256 || null,
      dimensions,
      bytes: Number.isFinite(frame.bytesLength) ? frame.bytesLength
        : (Number.isFinite(frame.bytes) ? frame.bytes : (Number.isFinite(frame.encodedBytes) ? frame.encodedBytes : null)),
      mapping: frame.mapping || null,
      provenance: frame.provenance || null,
      sample: frame.sample || null,
      imageRef: { frameId: frame.frameId, sha256: frame.sha256 || null },
      image: null,
      incomplete: Array.isArray(frame.incomplete) ? [...frame.incomplete] : [],
      decodeFailed: frame.decodeFailed === true || frame.decode?.failed === true,
    };
  }

  #dynamicFrameBytes(session, frame) {
    if (frame && frame.bytes instanceof Uint8Array) return Buffer.from(frame.bytes);
    if (frame && typeof frame.bytes === 'string') {
      const cached = session.imageCache.get(frame.frameId);
      if (cached) return Buffer.from(cached.base64, 'base64');
    }
    const cached = session.imageCache.get(frame.frameId);
    return cached ? Buffer.from(cached.base64, 'base64') : null;
  }

  /**
   * Crop-on-delivery. Why: an Agent asked to "understand the animation" used to receive a whole-page
   * screenshot that literally contains the panel title and the answer text (`t=233ms tx=93.32
   * opacity=0.855`). Cropping to the animation body removes that leak and is far smaller (measured:
   * 61,824 B full JPEG vs 4,198 B PNG for a 243x139 ROI, 14.7x). This path decodes ONLY when an
   * explicit `region` is requested; the encoded-only path stays decode-free.
   */
  async #dynamicCropFrame(session, frame, region) {
    const core = this.dynamic.core;
    if (!core) return { ok: false, code: 'crop-unavailable' };
    const dimensions = frame.dimensions || {};
    const width = Number(dimensions.width) || 0;
    const height = Number(dimensions.height) || 0;
    if (!(width > 0 && height > 0)) return { ok: false, code: 'crop-dimensions-unavailable' };
    if (region.x + region.width > width || region.y + region.height > height) {
      throw new BrowserError('DYNAMIC_INVALID_ARGUMENT', 'region 超出帧图像范围', {
        field: 'region', region, frame: { width, height },
      });
    }
    session.counters.cropDecodes += 1;
    let decoded = null;
    try {
      if (typeof core.cropFrameRoi === 'function') {
        // Core-provided crop (preferred once available): it may return PNG bytes directly.
        decoded = core.cropFrameRoi(frame, region);
        if (decoded && decoded.ok === true && typeof decoded.pngBase64 === 'string') {
          return {
            ok: true,
            image: decoded.pngBase64,
            bytes: decoded.bytes || Buffer.byteLength(decoded.pngBase64, 'base64'),
            roiSha256: decoded.roiSha256 || null,
            width: region.width,
            height: region.height,
            encodedSha256: decoded.sha256 || null,
          };
        }
      }
      let source = null;
      if (typeof core.materializeFrameImage === 'function') source = core.materializeFrameImage(frame);
      else if (typeof core.decodeFrameRgba === 'function' && frame.bytes) source = core.decodeFrameRgba({ encoding: frame.encoding, bytes: frame.bytes });
      if (!source || source.ok !== true) {
        session.counters.cropFailures += 1;
        return { ok: false, code: source && source.code ? source.code : 'crop-unavailable' };
      }
      const image = source.image || source;
      const rgba = image.rgba;
      if (!rgba || image.width < region.x + region.width || image.height < region.y + region.height) {
        session.counters.cropFailures += 1;
        return { ok: false, code: 'crop-bounds-mismatch' };
      }
      const stride = image.width * 4;
      const roi = Buffer.allocUnsafe(region.width * region.height * 4);
      for (let row = 0; row < region.height; row += 1) {
        const from = (region.y + row) * stride + region.x * 4;
        rgba.subarray(from, from + region.width * 4).forEach((value, index) => { roi[row * region.width * 4 + index] = value; });
      }
      const roiSha256 = dynamicSha256(roi);
      const png = encodePngRgba({ width: region.width, height: region.height, rgba: roi });
      return {
        ok: true,
        image: Buffer.from(png).toString('base64'),
        bytes: png.length,
        roiSha256,
        width: region.width,
        height: region.height,
        encodedSha256: dynamicSha256(png),
      };
    } catch (error) {
      session.counters.cropFailures += 1;
      if (error instanceof BrowserError) throw error;
      return { ok: false, code: 'crop-failed' };
    }
  }

  /** `browser_motion_observe` (contract §2.2 / §3.2). Stored reads never ensure or take a lease. */
  async dynamicObserve(args, exec, signal) {
    assertDynamicKeys(args, ['motionSessionId', 'fresh', 'sinceSeq', 'cursor', 'limit', 'window', 'frameIds', 'includeImages', 'region'], 'motion_observe');
    const motionSessionId = args.motionSessionId;
    if (typeof motionSessionId !== 'string' || motionSessionId === '') {
      throw new BrowserError('DYNAMIC_INVALID_ARGUMENT', 'motionSessionId 必须是非空字符串', { field: 'motionSessionId' });
    }
    const session = this.#dynamicSessionFor(motionSessionId);
    if (!session) throw new BrowserError('DYNAMIC_SESSION_NOT_FOUND', '视觉会话不存在或不属于本 scope', { motionSessionId });
    const fresh = args.fresh === undefined ? false : args.fresh;
    if (typeof fresh !== 'boolean') throw new BrowserError('DYNAMIC_INVALID_ARGUMENT', 'fresh 必须是布尔值', { field: 'fresh' });
    const includeImages = args.includeImages === undefined ? false : args.includeImages;
    if (typeof includeImages !== 'boolean') throw new BrowserError('DYNAMIC_INVALID_ARGUMENT', 'includeImages 必须是布尔值', { field: 'includeImages' });
    let region = null;
    if (args.region !== undefined) {
      region = dynamicRect(args.region, 'region', { integer: true });
      if (includeImages !== true) {
        throw new BrowserError('DYNAMIC_INVALID_ARGUMENT', 'region 只能与 includeImages:true 同用', { field: 'region' });
      }
    }
    if (args.sinceSeq !== undefined) {
      if (!Number.isInteger(args.sinceSeq) || args.sinceSeq < 0) {
        throw new BrowserError('DYNAMIC_INVALID_ARGUMENT', 'sinceSeq 必须是 ≥0 的整数', { field: 'sinceSeq' });
      }
    }
    if (args.cursor !== undefined) {
      if (typeof args.cursor !== 'string' || args.cursor === '' || Buffer.byteLength(args.cursor, 'utf8') > 2048) {
        throw new BrowserError('DYNAMIC_INVALID_ARGUMENT', 'cursor 必须是 ≤2048 字节的非空字符串', { field: 'cursor' });
      }
    }
    if (args.sinceSeq !== undefined && args.cursor !== undefined) {
      throw new BrowserError('DYNAMIC_INVALID_ARGUMENT', 'cursor 与 sinceSeq 互斥', { fields: ['cursor', 'sinceSeq'] });
    }
    let limit = DYNAMIC_INTERNAL.observeLimit;
    if (args.limit !== undefined) limit = dynamicInteger(args.limit, 'limit', 1, DYNAMIC_INTERNAL.observeLimitMax);
    let window = null;
    if (args.window !== undefined) window = normalizeDynamicWindow(args.window);
    const frameIds = dynamicIdList(args.frameIds, 'frameIds', DYNAMIC_LIMITS.maxIds);
    if (frameIds && (window || args.cursor !== undefined || args.sinceSeq !== undefined)) {
      throw new BrowserError('DYNAMIC_INVALID_ARGUMENT', 'frameIds 与 window/cursor/sinceSeq 互斥', { fields: ['frameIds'] });
    }
    if (fresh) {
      if (args.sinceSeq !== undefined || args.cursor !== undefined || window || frameIds) {
        throw new BrowserError('DYNAMIC_INVALID_ARGUMENT', 'fresh 禁止 sinceSeq/cursor/window/frameIds', { fields: ['fresh'] });
      }
      if (!session.captureVisual || session.state !== 'running') {
        throw new BrowserError('DYNAMIC_SESSION_NOT_FOUND', 'fresh 只允许当前活动的视觉会话', { reason: 'not-active' });
      }
      // Explicit page action: the caller took the page queue, so ensure is allowed here (and only
      // here for observe). Stored reads never reach this branch.
      await this.ensure(signal);
      const sample = await this.#dynamicFreshSample(session, signal);
      let freshFrame = sample.frame;
      if (region) {
        const raw = { dimensions: freshFrame.dimensions, encoding: freshFrame.encoding, bytes: freshFrame.__bytes, sha256: freshFrame.sha256 };
        const cropped = await this.#dynamicCropFrame(session, raw, region);
        if (cropped.ok) {
          freshFrame = { ...freshFrame,
            image: { image: cropped.image, bytes: cropped.bytes, sha256: cropped.encodedSha256, width: cropped.width, height: cropped.height, mediaType: 'image/png', delivery: { mode: 'inline-base64', persisted: false } },
            crop: { region, sourceSha256: raw.sha256, sourceDimensions: raw.dimensions, sourceEncoding: raw.encoding, roiSha256: cropped.roiSha256, outputBytes: cropped.bytes } };
        } else {
          freshFrame = { ...freshFrame, image: null, crop: { failed: true, code: cropped.code, region }, incomplete: [...new Set([...(freshFrame.incomplete || []), 'crop-unavailable'])] };
        }
      }
      this.#dynamicTouch('motion.observe', {});
      return {
        ok: true, frames: [freshFrame], events: [], fromSeq: null, toSeq: null,
        cursor: { next: null }, integrity: this.#dynamicIntegrity(session), sample: sample.sample,
        // TOOL-P1-03: the same measured sampling block as session start/status.
        sampling: this.#dynamicSamplingView(session),
        cropStats: { decodes: session.counters.cropDecodes, failures: session.counters.cropFailures },
        evidence: this.#dynamicEvidence('motion.observe', session),
      };
    }
    if (!session.frames) {
      return {
        ok: true, frames: [], events: [], fromSeq: null, toSeq: null,
        cursor: { next: null }, integrity: this.#dynamicIntegrity(session), sample: null,
        sampling: this.#dynamicSamplingView(session),
        evidence: this.#dynamicEvidence('motion.observe', session, { incomplete: ['no-frame-store'] }),
      };
    }
    let sinceSeq = args.sinceSeq === undefined ? null : args.sinceSeq;
    if (args.cursor !== undefined) {
      const decoded = decodeDynamicCursor(args.cursor);
      if (!decoded || decoded.d !== session.dynamicSessionId || decoded.m !== session.motionSessionId) {
        throw new BrowserError('DYNAMIC_INVALID_ARGUMENT', 'cursor 不属于本视觉会话', { field: 'cursor' });
      }
      sinceSeq = decoded.s;
    }
    const rawFrames = this.#dynamicFramesOf(session, { frameIds, window, sinceSeq, limit });
    let frames = rawFrames.map((frame) => this.#dynamicFrameMeta(session, frame));
    if (frameIds) {
      const found = new Set(frames.map((frame) => frame.frameId));
      const missing = frameIds.filter((id) => !found.has(id));
      if (missing.length) throw new BrowserError('DYNAMIC_EVENT_NOT_FOUND', '帧不存在或已被淘汰', { idKind: 'frame', ids: missing });
    }
    const fromSeq = frames.length ? Math.min(...frames.map((frame) => frame.seq)) : null;
    const toSeq = frames.length ? Math.max(...frames.map((frame) => frame.seq)) : null;
    let nextCursor = null;
    if (frames.length >= limit && toSeq !== null && session.frames.highWater > toSeq) {
      nextCursor = encodeDynamicCursor({ d: session.dynamicSessionId, m: session.motionSessionId, s: toSeq + 1 });
    }
    if (includeImages) {
      const candidates = frameIds
        ? rawFrames
        : rawFrames.slice(0, limit);
      if (candidates.length > T4_LIMITS.maxImagesPerObserve) {
        throw new BrowserError('DYNAMIC_INVALID_ARGUMENT', 'includeImages 选中帧超过 3 帧，请缩小 frameIds/limit', {
          field: 'includeImages', selected: candidates.length, max: T4_LIMITS.maxImagesPerObserve,
        });
      }
      let totalBytes = 0;
      for (const [index, raw] of candidates.entries()) {
        const meta = frames[index];
        if (region) {
          const cropped = await this.#dynamicCropFrame(session, raw, region);
          if (!cropped.ok) {
            meta.image = null;
            meta.crop = { failed: true, code: cropped.code, region };
            meta.incomplete = [...new Set([...(meta.incomplete || []), 'crop-unavailable'])];
            continue;
          }
          if (totalBytes + cropped.bytes > T4_LIMITS.maxEvidenceBytes) {
            meta.image = null;
            meta.crop = { failed: true, code: 'evidence-budget', region };
            meta.incomplete = [...new Set([...(meta.incomplete || []), 'crop-unavailable'])];
            continue;
          }
          totalBytes += cropped.bytes;
          meta.image = {
            image: cropped.image, bytes: cropped.bytes, sha256: cropped.encodedSha256,
            width: cropped.width, height: cropped.height, mediaType: 'image/png',
            attachment: null, attachmentId: null, imageDelivery: 'inline-base64',
            attachmentError: null, file: null, delivery: { mode: 'inline-base64', persisted: false },
          };
          meta.crop = {
            region,
            sourceSha256: raw.sha256 || meta.sha256,
            sourceDimensions: raw.dimensions || meta.dimensions,
            sourceEncoding: raw.encoding || meta.encoding,
            roiSha256: cropped.roiSha256,
            outputBytes: cropped.bytes,
          };
          continue;
        }
        const bytes = this.#dynamicFrameBytes(session, raw);
        if (!bytes) {
          meta.image = null;
          meta.imageRef = { frameId: meta.frameId, sha256: meta.sha256 };
          meta.imageUnavailableReason = 'bytes-unavailable';
          continue;
        }
        if (bytes.length > DYNAMIC_INTERNAL.imageBytes || totalBytes + bytes.length > DYNAMIC_INTERNAL.imageBytesTotal) {
          meta.image = null;
          meta.imageUnavailableReason = 'image-budget';
          continue;
        }
        totalBytes += bytes.length;
        meta.image = {
          image: bytes.toString('base64'), bytes: bytes.length, sha256: meta.sha256,
          width: meta.dimensions.width, height: meta.dimensions.height,
          mediaType: meta.encoding === 'png' ? 'image/png' : 'image/jpeg',
          attachment: null, attachmentId: null, imageDelivery: 'inline-base64',
          attachmentError: null, file: null, delivery: { mode: 'inline-base64', persisted: false },
        };
      }
    }
    const events = this.#dynamicQueryEvents(session, {}) || [];
    this.#dynamicTouch('motion.observe', {});
    return {
      ok: true, frames, events, fromSeq, toSeq, cursor: { next: nextCursor },
      integrity: this.#dynamicIntegrity(session), sample: null,
      // TOOL-P1-03: measured sampling cadence, readable even when frames were evicted/stopped.
      sampling: this.#dynamicSamplingView(session),
      cropStats: { decodes: session.counters.cropDecodes, failures: session.counters.cropFailures },
      evidence: this.#dynamicEvidence('motion.observe', session),
    };
  }

  #dynamicQueryEvents(session, query) {
    if (!session.events) return [];
    try {
      const listed = session.events.query(query || {});
      if (Array.isArray(listed)) return listed;
      if (listed && Array.isArray(listed.events)) return listed.events;
      return [];
    } catch { return []; }
  }

  async #dynamicFreshSample(session, signal) {
    // Explicit page action: one real screenshot sample with a measured begin/end interval. It is
    // NOT stored as screencast evidence (different source, no sourceTimestamp) and never claims a
    // render time: `sample.fromMs/toMs` stay null (the begin/end interval is the uncertainty).
    const beginMonoMs = dynamicMonoNow();
    const captured = await this.cdp.send('Page.captureScreenshot', { format: 'jpeg', quality: 72 }, { signal, timeoutMs: 5000 });
    const endMonoMs = dynamicMonoNow();
    const bytes = Buffer.from(captured.data || '', 'base64');
    const meta = this.#dynamicMapping({});
    const frame = {
      frameId: 'frm_' + randomUUID().replace(/-/gu, '').slice(0, 24),
      seq: null, segmentId: null, source: 'captureScreenshot', sourceTimestamp: null,
      receivedMonoMs: beginMonoMs, encoding: 'jpeg', sha256: dynamicSha256(bytes),
      rgbaSha256: null, dimensions: { width: meta.dimensions.width, height: meta.dimensions.height },
      bytes: bytes.length, mapping: meta,
      provenance: {
        producer: 'host', sourceKind: 'cdp-page-capture-screenshot', adapterId: null,
        adapterVersion: null, trust: 'cdp-observed', evidenceIds: [], rawHash: dynamicSha256(bytes),
      },
      sample: { beginMonoMs, endMonoMs },
      imageRef: null, image: null, incomplete: ['source-timestamp-missing'],
    };
    session.counters.samplingFailures += 0;
    Object.defineProperty(frame, '__bytes', { value: bytes, enumerable: false });
    return {
      frame,
      sample: {
        beginMonoMs, endMonoMs,
        fromMs: null, toMs: null,
        durationMs: Math.round((endMonoMs - beginMonoMs) * 1000) / 1000,
        source: 'captureScreenshot',
      },
    };
  }

  /** `browser_motion_analyze` (contract §2.4 / §3.4). Offline: never captures a new frame. */
  async dynamicAnalyze(args) {
    assertDynamicKeys(args, ['motionSessionId', 'window', 'frameIds', 'assertions'], 'motion_analyze');
    const motionSessionId = args.motionSessionId;
    if (typeof motionSessionId !== 'string' || motionSessionId === '') {
      throw new BrowserError('DYNAMIC_INVALID_ARGUMENT', 'motionSessionId 必须是非空字符串', { field: 'motionSessionId' });
    }
    const session = this.#dynamicSessionFor(motionSessionId);
    if (!session) throw new BrowserError('DYNAMIC_SESSION_NOT_FOUND', '视觉会话不存在或不属于本 scope', { motionSessionId });
    const window = args.window === undefined ? null : normalizeDynamicWindow(args.window);
    const frameIds = dynamicIdList(args.frameIds, 'frameIds', DYNAMIC_LIMITS.maxIds);
    if ((window && frameIds) || (!window && !frameIds)) {
      throw new BrowserError('DYNAMIC_INVALID_ARGUMENT', 'window/frameIds 恰好给一个', { fields: ['window', 'frameIds'] });
    }
    const assertions = normalizeDynamicAssertions(args.assertions);
    if (!session.frames) {
      return {
        ok: true, results: [], summary: { pass: 0, warn: 0, fail: 0, inconclusive: 0, blocked: assertions.length },
        verdict: 'BLOCKED', exitCode: 2, integrity: this.#dynamicIntegrity(session), algorithmVersion: DYNAMIC_ALGORITHM_VERSION,
        evidence: this.#dynamicEvidence('motion.analyze', session, { incomplete: ['no-frame-store'] }),
      };
    }
    const core = await this.#dynamicLoadCore();
    // Split assertions: interval-only jank never needs pixels, so it must not pay materialization
    // for the whole capture (real-host 180-frame case). Pixel assertions run in a second bounded
    // core call; both budgets are reported separately and summed as budgetUsedMs.
    const startedAt = Date.now();
    const fastAssertions = assertions.filter((assertion) => assertion.type === 'jank');
    const pixelAssertions = assertions.filter((assertion) => assertion.type !== 'jank');
    const rawFrames = this.#dynamicFramesOf(session, { frameIds, window, limit: T4_LIMITS.maxFramesHard });
    const metadataFrames = rawFrames.map((frame) => ({
      frameId: frame.frameId,
      seq: Number.isInteger(frame.seq) ? frame.seq : null,
      timelineMs: Number.isFinite(frame.timelineMs) ? frame.timelineMs : null,
      receivedMonoMs: Number.isFinite(frame.receivedMonoMs) ? frame.receivedMonoMs : null,
      sourceTimestamp: Number.isFinite(frame.sourceTimestamp) ? frame.sourceTimestamp : null,
      sourceClock: frame.sourceClock || null,
      mapping: frame.mapping || null,
      encoding: frame.encoding || session.config.encoding,
      segmentId: frame.segmentId || null,
      incomplete: Array.isArray(frame.incomplete) ? [...frame.incomplete] : [],
      // Deliberately NO bytes/image: the core must not decode for a jank-only assertion.
    }));
    const runGroup = async (groupAssertions, frames) => {
      if (groupAssertions.length === 0) return null;
      const started = Date.now();
      const value = await core.runMotionAssertions({
        frames,
        assertions: groupAssertions,
        window,
        frameIds,
        events: this.#dynamicQueryEvents(session, {}),
        integrity: this.#dynamicIntegrity(session),
      });
      return { value, elapsedMs: Date.now() - started };
    };
    const fastRun = await runGroup(fastAssertions, metadataFrames);
    const pixelRun = await runGroup(pixelAssertions, rawFrames);
    const byId = new Map();
    for (const run of [fastRun, pixelRun]) {
      if (!run) continue;
      for (const result of run.value.results || []) byId.set(result.id, result);
    }
    const mergedResults = assertions.map((assertion) => byId.get(assertion.id)).filter(Boolean);
    const summary = normalizeDynamicSummary(null, mergedResults);
    const verdict = normalizeDynamicVerdict(null, mergedResults);
    const exitCode = verdict === 'FAIL' ? 1 : (['BLOCKED', 'INCONCLUSIVE'].includes(verdict) ? 2 : 0);
    const budgetUsedMs = (fastRun ? fastRun.elapsedMs : 0) + (pixelRun ? pixelRun.elapsedMs : 0);
    const result = {
      results: mergedResults,
      summary,
      verdict,
      exitCode,
      integrity: this.#dynamicIntegrity(session),
      algorithmVersion: DYNAMIC_ALGORITHM_VERSION,
      budgetUsedMs,
      budgetSplitMs: { jank: fastRun ? fastRun.elapsedMs : 0, pixel: pixelRun ? pixelRun.elapsedMs : 0 },
      decodedForJank: false,
    };
    this.#dynamicTouch('motion.analyze', { verdict });
    return {
      ok: true,
      results: Array.isArray(result && result.results) ? result.results : [],
      summary, verdict, exitCode,
      integrity: this.#dynamicIntegrity(session),
      algorithmVersion: DYNAMIC_ALGORITHM_VERSION,
      budgetUsedMs: result.budgetUsedMs,
      budgetSplitMs: result.budgetSplitMs,
      evidence: this.#dynamicEvidence('motion.analyze', session, { verdict }),
    };
  }

  /* ---- T4 motion control (M2): WAAPI adapter, readback, restore ---- */

  async #dynamicAdapterCall(payload, signal) {
    const expression = '(' + DYNAMIC_CONTROL_ADAPTER_FN + ')(' + JSON.stringify(payload) + ')';
    const result = await this.evaluate(expression, true, signal);
    if (!result || result.ok !== true) {
      throw new BrowserError('DYNAMIC_CONTROL_CONFLICT', '控制适配器调用失败', { reason: 'adapter-eval-failed' });
    }
    const value = result.value;
    if (!value || value.ok !== true) {
      if (value && value.code === 'TARGET_NOT_FOUND') {
        throw new BrowserError('DYNAMIC_EVENT_NOT_FOUND', '控制目标不存在', { idKind: 'target', ids: value.missing || [] });
      }
      if (value && value.code === 'TARGET_AMBIGUOUS') {
        throw new BrowserError('DYNAMIC_CONTROL_CONFLICT', '控制目标不唯一', { reason: 'target-ambiguous', ambiguous: value.ambiguous || [] });
      }
      throw new BrowserError('DYNAMIC_CONTROL_CONFLICT', '控制适配器拒绝执行', { reason: 'adapter-refused' });
    }
    return value;
  }

  #dynamicResolveListed(targets, targetId) {
    const wanted = String(targetId);
    const direct = targets.find((item) => item.targetId === wanted);
    if (direct) return direct;
    return targets.find((item) => item.animationId === wanted || item.animationName === wanted || item.selector === wanted) || null;
  }

  #dynamicControlState(session) {
    if (!session.control) {
      session.control = {
        restoreToken: 'rst_' + randomUUID().replace(/-/gu, ''),
        adapterId: null,
        documentEpoch: this.t2.documentEpoch,
        targets: [],
        sideEffects: [],
        restoreStatus: { status: 'not-needed', attempted: [], restored: [], failed: [], conflicts: [], lastObserved: [] },
      };
    }
    session.restoreStatus = session.control.restoreStatus;
    return session.control;
  }

  #dynamicTargetState(entry) {
    return {
      targetId: entry.targetId,
      documentEpoch: this.t2.documentEpoch,
      playState: entry.state ? entry.state.playState : null,
      currentTimeMs: entry.state && Number.isFinite(entry.state.currentTimeMs) ? entry.state.currentTimeMs : null,
      playbackRate: entry.state && Number.isFinite(entry.state.playbackRate) ? entry.state.playbackRate : null,
      observedAtMonoMs: dynamicMonoNow(),
    };
  }

  #dynamicControlFields(control, applied, failedIndex, afterById) {
    const fields = [];
    const order = ['playState', 'currentTimeMs', 'playbackRate'];
    control.targets.forEach((entry, index) => {
      const after = afterById.get(entry.targetId);
      const status = failedIndex !== null && index >= failedIndex ? 'failed' : (applied.includes(entry.targetId) ? 'applied' : 'failed');
      for (const field of order) {
        fields.push({
          index,
          targetId: entry.targetId,
          field,
          status,
          errorCode: status === 'failed' ? 'DYNAMIC_CONTROL_CONFLICT' : null,
          before: entry.original ? entry.original[field] : null,
          after: after ? after[field] : null,
        });
      }
    });
    return fields;
  }

  /** Best-effort restore of every field this session wrote; never overwrites an external change. */
  async #dynamicRestoreControl(session, reason = 'stop') {
    if (!session || !session.control || session.control.targets.length === 0) return session ? session.restoreStatus : null;
    const control = session.control;
    const status = control.restoreStatus;
    if (!this.cdp || this.cdp.closed) {
      status.status = 'failed';
      status.failed = control.targets.map((entry) => ({ targetId: entry.targetId, code: 'DYNAMIC_RESTORE_FAILED', reason: 'cdp-unavailable:' + reason }));
      return status;
    }
    let listed;
    try { listed = await this.#dynamicAdapterCall({ action: 'list' }); } catch { listed = null; }
    if (!listed) {
      status.status = 'failed';
      status.failed = control.targets.map((entry) => ({ targetId: entry.targetId, code: 'DYNAMIC_RESTORE_FAILED', reason: 'list-failed:' + reason }));
      return status;
    }
    const currentById = new Map();
    for (const entry of control.targets) {
      const found = this.#dynamicResolveListed(listed.targets, entry.targetId);
      if (found) currentById.set(entry.targetId, found);
    }
    const conflicts = [];
    const restoreTargets = [];
    for (const entry of control.targets) {
      const current = currentById.get(entry.targetId);
      if (!current) {
        status.failed.push({ targetId: entry.targetId, code: 'DYNAMIC_EVENT_NOT_FOUND', reason: 'target-gone' });
        continue;
      }
      const written = entry.lastWritten || {};
      let externalField = null;
      for (const field of ['playState', 'currentTimeMs', 'playbackRate']) {
        if (written[field] === undefined || written[field] === null) continue;
        if (field === 'playState') {
          if (current.playState !== written.playState) externalField = field;
        } else if (field === 'playbackRate') {
          if (Math.abs(Number(current.playbackRate) - Number(written.playbackRate)) > 0.01) externalField = field;
        }
        // currentTimeMs is deliberately NOT an identity signal: a running animation advances it and
        // a paused page can still seek; conflict is decided by playState + playbackRate only.
        if (externalField) break;
      }
      if (externalField) { conflicts.push({ targetId: entry.targetId, field: externalField }); continue; }
      restoreTargets.push({ entry, current });
    }
    status.conflicts = conflicts;
    status.lastObserved = restoreTargets.map(({ current }) => ({
      targetId: current.targetId, documentEpoch: this.t2.documentEpoch,
      playState: current.playState, currentTimeMs: current.currentTimeMs,
      playbackRate: current.playbackRate, observedAtMonoMs: dynamicMonoNow(),
    }));
    if (restoreTargets.length === 0) {
      status.status = conflicts.length ? 'conflict' : 'not-needed';
      return status;
    }
    try {
      const payload = {
        action: 'restore',
        targetIds: restoreTargets.map(({ entry }) => entry.targetId),
        originals: restoreTargets.map(({ entry }) => entry.original),
      };
      const result = await this.#dynamicAdapterCall(payload);
      status.attempted = restoreTargets.map(({ entry }) => entry.targetId);
      const appliedSet = new Set(result.applied || []);
      status.restored = status.attempted.filter((id) => appliedSet.has(id));
      if (result.failedIndex !== null && result.failedIndex !== undefined) {
        const failed = restoreTargets[result.failedIndex];
        status.failed.push({ targetId: failed ? failed.entry.targetId : 'unknown', code: 'DYNAMIC_RESTORE_FAILED', reason: 'apply-failed' });
      }
      status.status = status.failed.length ? 'partial' : (conflicts.length ? 'partial' : 'restored');
    } catch (error) {
      status.status = 'failed';
      status.failed.push({ targetId: '*', code: 'DYNAMIC_RESTORE_FAILED', reason: String((error && error.message) || error) });
    }
    return status;
  }

  /** `browser_motion_control` (contract §2.3 / §3.3). Page operation; explicit caller action only. */
  async dynamicControl(args, exec, signal) {
    assertDynamicKeys(args, ['motionSessionId', 'action', 'adapterId', 'targetIds', 'timeMs', 'rate', 'restoreToken'], 'motion_control');
    const action = String(args.action || '');
    const actions = ['pause', 'resume', 'seek', 'rate', 'restore'];
    if (!actions.includes(action)) {
      throw new BrowserError('DYNAMIC_INVALID_ARGUMENT', 'control.action 不合法', { field: 'action', allowed: actions });
    }
    const motionSessionId = args.motionSessionId;
    if (typeof motionSessionId !== 'string' || motionSessionId === '') {
      throw new BrowserError('DYNAMIC_INVALID_ARGUMENT', 'motionSessionId 必须是非空字符串', { field: 'motionSessionId' });
    }
    const session = this.#dynamicSessionFor(motionSessionId);
    if (!session || !session.captureVisual) {
      throw new BrowserError('DYNAMIC_SESSION_NOT_FOUND', '视觉会话不存在或不属于本 scope', { motionSessionId });
    }
    // A retained session may still control the same page/document after stop (contract §3.5:
    // stop/cancel/disconnect/dispose restore and late restore must stay reachable).
    if (session.pageGeneration !== null && session.pageGeneration !== undefined && this.page
      && session.pageGeneration !== this.page.generation) {
      throw new BrowserError('DYNAMIC_CONTROL_CONFLICT', '页面代次已变化，拒绝控制', {
        expectedPageGeneration: session.pageGeneration, actualPageGeneration: this.page.generation,
      });
    }
    const restore = action === 'restore';
    let targetIds = null;
    let adapterId = null;
    if (restore) {
      const forbidden = ['adapterId', 'targetIds', 'timeMs', 'rate'].filter((key) => args[key] !== undefined);
      if (forbidden.length) throw new BrowserError('DYNAMIC_INVALID_ARGUMENT', 'restore 禁止字段 ' + forbidden.join(','), { fields: forbidden });
      if (typeof args.restoreToken !== 'string' || args.restoreToken === '') {
        throw new BrowserError('DYNAMIC_INVALID_ARGUMENT', 'restore 必须给 restoreToken', { field: 'restoreToken' });
      }
      adapterId = session.control ? session.control.adapterId : 'waapi';
    } else {
      if (args.restoreToken !== undefined) throw new BrowserError('DYNAMIC_INVALID_ARGUMENT', '非 restore 禁止 restoreToken', { field: 'restoreToken' });
      if (typeof args.adapterId !== 'string' || args.adapterId === '') {
        throw new BrowserError('DYNAMIC_INVALID_ARGUMENT', '非 restore 必须给 adapterId', { field: 'adapterId' });
      }
      adapterId = args.adapterId;
      if (adapterId !== 'waapi') {
        throw new BrowserError('DYNAMIC_SOURCE_UNAVAILABLE', '控制适配器不可用', { adapterId, supported: ['waapi'] });
      }
      targetIds = dynamicIdList(args.targetIds, 'targetIds', T4_LIMITS.maxControlTargets);
      if (!targetIds || targetIds.length === 0) {
        throw new BrowserError('DYNAMIC_INVALID_ARGUMENT', '非 restore 必须给 1–20 个 targetIds', { field: 'targetIds' });
      }
      if (action === 'seek') {
        if (args.timeMs === undefined) throw new BrowserError('DYNAMIC_INVALID_ARGUMENT', 'seek 必须给 timeMs', { field: 'timeMs' });
        dynamicFinite(args.timeMs, 'timeMs');
        if (args.timeMs < 0 || args.timeMs > 10000) throw new BrowserError('DYNAMIC_INVALID_ARGUMENT', 'timeMs 必须在 [0,10000]', { field: 'timeMs' });
        if (args.rate !== undefined) throw new BrowserError('DYNAMIC_INVALID_ARGUMENT', 'seek 禁止 rate', { field: 'rate' });
      } else if (action === 'rate') {
        if (args.rate === undefined) throw new BrowserError('DYNAMIC_INVALID_ARGUMENT', 'rate 必须给 rate', { field: 'rate' });
        dynamicFinite(args.rate, 'rate');
        if (args.rate < 0.1 || args.rate > 4) throw new BrowserError('DYNAMIC_INVALID_ARGUMENT', 'rate 必须在 [0.1,4]', { field: 'rate' });
        if (args.timeMs !== undefined) throw new BrowserError('DYNAMIC_INVALID_ARGUMENT', 'rate 禁止 timeMs', { field: 'timeMs' });
      } else if (args.timeMs !== undefined || args.rate !== undefined) {
        throw new BrowserError('DYNAMIC_INVALID_ARGUMENT', action + ' 禁止 timeMs/rate', { fields: ['timeMs', 'rate'] });
      }
    }
    if (restore) {
      if (!session.control || args.restoreToken !== session.control.restoreToken) {
        throw new BrowserError('DYNAMIC_EVENT_NOT_FOUND', 'restoreToken 不存在或不属于本会话', { idKind: 'restoreToken' });
      }
    }
    // Page/document identity: a document change invalidates every target identity.
    const control = session.control || this.#dynamicControlState(session);
    if (this.t2.documentEpoch !== control.documentEpoch && this.t2.documentEpoch !== session.documentEpoch) {
      throw new BrowserError('DYNAMIC_CONTROL_CONFLICT', '文档代次已变化，拒绝控制', {
        expectedDocumentEpoch: control.documentEpoch, actualDocumentEpoch: this.t2.documentEpoch,
      });
    }
    const listed = await this.#dynamicAdapterCall({ action: 'list' }, signal);
    const currentById = new Map();
    for (const targetId of (restore
      ? (session.control ? session.control.targets.map((entry) => entry.targetId) : [])
      : (targetIds || []))) {
      const found = this.#dynamicResolveListed(listed.targets, targetId);
      if (found) currentById.set(targetId, found);
    }
    if (restore) {
      const status = await this.#dynamicRestoreControl(session, 'restore');
      if (status.status === 'restored' && session.control) session.control.targets = [];
      const requested = { action, adapterId, targetIds: status.attempted || [], timeMs: null, rate: null };
      return {
        ok: true, requested,
        applied: status.restored, failedIndex: null,
        fields: [],
        targets: requested.targetIds,
        before: session.control ? session.control.targets.map((entry) => this.#dynamicTargetState({ ...entry, state: currentById.get(entry.targetId) })) : [],
        after: [], restoreToken: null,
        restoreStatus: status,
        sideEffects: ['no-page-rollback'],
        evidence: this.#dynamicEvidence('motion.control', session),
      };
    }
    const missing = targetIds.filter((id) => !currentById.has(id));
    if (missing.length) {
      throw new BrowserError('DYNAMIC_EVENT_NOT_FOUND', '控制目标不存在', { idKind: 'target', ids: missing });
    }
    // Save the original state once per target; never overwrite the first observed original.
    const targets = control.targets;
    for (const targetId of targetIds) {
      if (!targets.some((entry) => entry.targetId === targetId)) {
        const current = currentById.get(targetId);
        targets.push({ targetId, original: { playState: current.playState, currentTimeMs: current.currentTimeMs, playbackRate: current.playbackRate }, lastWritten: null });
      }
    }
    targets.sort((left, right) => targetIds.indexOf(left.targetId) - targetIds.indexOf(right.targetId));
    const before = targetIds.map((targetId) => this.#dynamicTargetState({ targetId, state: currentById.get(targetId) }));
    let result;
    try {
      result = await this.#dynamicAdapterCall({
        action,
        targetIds,
        timeMs: action === 'seek' ? args.timeMs : undefined,
        rate: action === 'rate' ? args.rate : undefined,
      }, signal);
    } catch (error) {
      const classified = asBrowserError(error);
      const status = await this.#dynamicRestoreControl(session, 'control-failed');
      classified.details = {
        ...(classified.details || {}),
        requested: { action, adapterId, targetIds, timeMs: action === 'seek' ? args.timeMs : null, rate: action === 'rate' ? args.rate : null },
        applied: [], failedIndex: 0, fields: [], before, after: [],
        restoreToken: control.restoreToken, restoreStatus: status, sideEffects: [action + ':attempted'],
      };
      throw classified;
    }
    const afterById = new Map(result.after.map((item) => [item.targetId, item]));
    const after = targetIds.map((targetId) => this.#dynamicTargetState({ targetId, state: afterById.get(targetId) }));
    for (const targetId of result.applied) {
      const state = afterById.get(targetId);
      const entry = targets.find((item) => item.targetId === targetId);
      if (entry && state) {
        entry.lastWritten = {
          playState: state.playState, currentTimeMs: state.currentTimeMs, playbackRate: state.playbackRate,
        };
        entry.lastWrittenAtMonoMs = dynamicMonoNow();
      }
    }
    control.adapterId = adapterId;
    control.sideEffects = [...new Set([...control.sideEffects, action + ':waapi'])];
    const fields = this.#dynamicControlFields(control, result.applied, result.failedIndex, afterById);
    if (result.failedIndex !== null && result.failedIndex !== undefined) {
      const status = await this.#dynamicRestoreControl(session, 'partial-control');
      const error = new BrowserError('DYNAMIC_CONTROL_CONFLICT', '控制部分失败，已尽力恢复', {
        requested: { action, adapterId, targetIds, timeMs: action === 'seek' ? args.timeMs : null, rate: action === 'rate' ? args.rate : null },
        applied: result.applied, failedIndex: result.failedIndex, fields, before, after,
        restoreToken: control.restoreToken, restoreStatus: status, sideEffects: [action + ':partial'],
      });
      throw error;
    }
    return {
      ok: true,
      requested: { action, adapterId, targetIds, timeMs: action === 'seek' ? args.timeMs : null, rate: action === 'rate' ? args.rate : null },
      applied: result.applied,
      failedIndex: null,
      fields,
      targets: targetIds,
      before,
      after,
      restoreToken: control.restoreToken,
      restoreStatus: control.restoreStatus,
      sideEffects: [action + ':waapi'],
      evidence: this.#dynamicEvidence('motion.control', session),
    };
  }

  /* ---- T4 dynamic correlation (M3) ---- */

  /** Called by the tool dispatcher after a successful page operation (T4 bridge input). */
  noteDynamicAction(action) {
    const session = this.dynamic.session;
    if (!session || session.state !== 'running' || !session.captureVisual) return;
    session.hostActions.push({
      actionId: action.actionId, tool: action.tool, target: action.target,
      atWallMs: action.atWallMs, atMonoMs: action.atMonoMs,
    });
    if (session.hostActions.length > 100) session.hostActions.shift();
  }

  /**
   * Authorized page-ledger snapshot (Lead 2026-11-04): read ONLY the documented truth ledgers.
   * `__t4.visual.anomalies` and every expectation field are deliberately excluded — the engine
   * never sees the oracle. Returns sourceUnavailable when the page exposes no `__t4`.
   */
  async #dynamicPageSnapshot(session) {
    const sendMonoMs = dynamicMonoNow();
    const attempt = async () => this.evaluate(`(function () {
      const out = { version: 1, wallNowMs: Date.now(), visual: null, net: null, dom: null };
      const v = window.__t4 && window.__t4.visual;
      if (v) {
        out.visual = {
          ops: Array.isArray(v.ops) ? v.ops : [],
          events: Array.isArray(v.events) ? v.events : [],
          clock: v.clock && typeof v.clock === 'object' ? v.clock : null,
        };
      }
      const n = window.__t4 && window.__t4.net;
      if (n) {
        out.net = {
          ops: Array.isArray(n.ops) ? n.ops : [],
          requests: Array.isArray(n.requests) ? n.requests : [],
          responses: Array.isArray(n.responses) ? n.responses : [],
          ui: Array.isArray(n.ui) ? n.ui : [],
          ws: n.ws && typeof n.ws === 'object' ? { state: n.ws.state, frames: Array.isArray(n.ws.frames) ? n.ws.frames : [] } : null,
          sse: n.sse && typeof n.sse === 'object' ? { state: n.sse.state, events: Array.isArray(n.sse.events) ? n.sse.events : [] } : null,
          polls: Array.isArray(n.polls) ? n.polls : [],
          errors: Array.isArray(n.errors) ? n.errors : [],
        };
      }
      if (v || n) {
        const errorEl = document.querySelector('#t4n-error');
        const cartEl = document.querySelector('#t4n-cart-count');
        const orderEl = document.querySelector('#t4n-order-status');
        const body = document.body;
        out.dom = {
          error: errorEl ? { hidden: errorEl.hidden === true, text: String(errorEl.textContent || '').slice(0, 120) } : null,
          cartCount: cartEl ? String(cartEl.textContent || '').trim() : null,
          orderStatus: orderEl ? String(orderEl.textContent || '').trim() : null,
          stage: body ? String(body.getAttribute('data-t4n-stage') || '') : null,
        };
      }
      return out;
    })()`, true, undefined);
    let result = await attempt();
    // One bounded retry: a real host can race an execution-context swap right after start.
    if (!result || result.ok !== true || !result.value || (!result.value.visual && !result.value.net)) {
      await new Promise((resolve) => setTimeout(resolve, 60));
      result = await attempt();
    }
    const receiveMonoMs = dynamicMonoNow();
    if (!result || result.ok !== true || !result.value || (!result.value.visual && !result.value.net)) {
      session.pageBridge.sourceUnavailable += 1;
      if (result && result.ok === false && result.error) {
        session.pageBridge.lastError = {
          code: result.error.code || null,
          message: String(result.error.message || '').slice(0, 300),
          exception: result.error.details ? JSON.parse(JSON.stringify(result.error.details)).exceptionDetails || null : null,
        };
      } else if (result && result.ok === true && result.value && !result.value.visual && !result.value.net) {
        session.pageBridge.lastError = { code: 'page-ledger-missing', message: 'main-world page exposes neither __t4.visual nor __t4.net' };
      } else {
        session.pageBridge.lastError = { code: 'page-ledger-no-result', message: 'Runtime.evaluate returned no value' };
      }
      return null;
    }
    const snapshot = result.value;
    const anchor = {
      clockId: 'page-wall',
      anchorId: 'pa_' + randomUUID().replace(/-/gu, '').slice(0, 12),
      offsetMs: ((sendMonoMs + receiveMonoMs) / 2) - Number(snapshot.wallNowMs),
      uncertaintyMs: Math.max(0.5, (receiveMonoMs - sendMonoMs) / 2),
      resolutionMs: 1,
      calibratedAtMonoMs: (sendMonoMs + receiveMonoMs) / 2,
      samples: 1,
      maxDeviationMs: 0,
    };
    session.pageBridge.anchors.push(anchor);
    if (session.pageBridge.anchors.length > T4_LIMITS.maxCalibrationSamples) session.pageBridge.anchors.shift();
    // Keep the lowest-uncertainty anchor for projection; a newer one replaces only when better.
    session.pageBridge.anchor = session.pageBridge.anchors.reduce(
      (best, item) => (!best || item.uncertaintyMs < best.uncertaintyMs ? item : best), null,
    );
    session.pageBridge.dom = snapshot.dom || null;
    session.pageBridge.lastAt = Date.now();
    return { snapshot, anchor: session.pageBridge.anchor };
  }

  #dynamicPageTime(session, atWallMs, atMs) {
    const anchor = session.pageBridge.anchor;
    const wall = Number(atWallMs);
    if (!anchor || !Number.isFinite(wall)) {
      return { timelineMs: null, logicalMs: Number.isFinite(Number(atMs)) ? Number(atMs) : null, wallMs: Number.isFinite(wall) ? wall : null, uncertaintyMs: null, anchorId: anchor ? anchor.anchorId : null };
    }
    return {
      timelineMs: Math.max(0, (wall + anchor.offsetMs) - session.startedMonoMs),
      logicalMs: Number.isFinite(Number(atMs)) ? Number(atMs) : null,
      wallMs: wall,
      uncertaintyMs: anchor.uncertaintyMs,
      anchorId: anchor.anchorId,
    };
  }

  #dynamicMatchHostAction(session, op) {
    const target = typeof op.target === 'string' ? op.target : '';
    const atWall = Number(op.atWallMs);
    if (!target) return null;
    const candidates = session.hostActions.filter((action) => {
      if (!Number.isFinite(atWall)) return true;
      return Math.abs(action.atWallMs - atWall) <= 1500
        && (action.target === target || String(action.target || '').includes(target.replace(/^#/, '')));
    });
    return candidates.length === 1 ? candidates[0] : null;
  }

  #dynamicPageEvents(session, page) {
    const events = [];
    const dom = page.dom || {};
    const push = (input) => { try { events.push(this.#dynamicCorrelationEvent(session, input)); } catch { /* one bad row must not kill the snapshot */ } };
    const visual = page.visual;
    if (visual) {
      for (const op of visual.ops || []) {
        const time = this.#dynamicPageTime(session, op.atWallMs, op.atMs);
        const host = this.#dynamicMatchHostAction(session, op);
        push({
          domain: 'operation', kind: 'page-op', phase: 'end',
          ts: {
            timelineMs: time.timelineMs, sourceTimestamp: null, sourceClock: 'page-wall',
            receivedMonoMs: null, wallMs: time.wallMs, logicalMs: time.logicalMs,
            anchorId: time.anchorId, uncertaintyMs: time.uncertaintyMs, resolutionMs: 1,
          },
          ids: { actionId: host ? host.actionId : null, opId: op.opId || null, frameId: null, traceIdHash: null, requestKey: null },
          sourceRef: { networkSessionId: session.networkSessionId, networkSeq: null, visualSessionId: session.motionSessionId, frameSeq: null },
          provenance: {
            producer: 'page-declared', sourceKind: 'page-ledger', adapterId: null, adapterVersion: null,
            trust: host ? 'host-observed' : 'page-declared', evidenceIds: host ? [host.actionId] : [], rawHash: null,
          },
          payload: { opId: op.opId || null, opKind: op.kind || null, target: op.target || null, hostActionId: host ? host.actionId : null, hostTool: host ? host.tool : null },
        });
      }
      for (const item of visual.events || []) {
        const time = this.#dynamicPageTime(session, item.atWallMs, item.atMs);
        const hostOp = item.causeOpId ? (visual.ops || []).find((op) => op.opId === item.causeOpId) : null;
        const host = hostOp ? this.#dynamicMatchHostAction(session, hostOp) : null;
        push({
          domain: 'visual', kind: item.kind || 'visual-event', phase: 'end',
          ts: {
            timelineMs: time.timelineMs, sourceTimestamp: null, sourceClock: 'page-wall',
            receivedMonoMs: null, wallMs: time.wallMs, logicalMs: time.logicalMs,
            anchorId: time.anchorId, uncertaintyMs: time.uncertaintyMs, resolutionMs: 1,
          },
          ids: { actionId: null, opId: item.causeOpId || null, frameId: null, traceIdHash: null, requestKey: null },
          sourceRef: { networkSessionId: session.networkSessionId, networkSeq: null, visualSessionId: session.motionSessionId, frameSeq: null },
          provenance: {
            producer: 'page-declared', sourceKind: 'page-ledger', adapterId: null, adapterVersion: null,
            trust: 'page-declared', evidenceIds: host ? [host.actionId] : [], rawHash: null,
          },
          payload: {
            causeOpId: item.causeOpId || null,
            // Explicit only with a unique Host-dispatched action + page receive record.
            causeVerified: Boolean(host && item.causeOpId),
            panel: item.panel || null, kind: item.kind || null,
            clockId: visual.clock && Number.isFinite(Number(visual.clock.startedAtWallMs))
              ? 'visual-clock-' + String(visual.clock.startedAtWallMs) : null,
          },
        });
      }
    }
    const net = page.net;
    if (net) {
      for (const op of net.ops || []) {
        const time = this.#dynamicPageTime(session, op.atWallMs, op.atMs);
        const host = this.#dynamicMatchHostAction(session, op);
        push({
          domain: 'operation', kind: 'page-op', phase: 'end',
          ts: {
            timelineMs: time.timelineMs, sourceTimestamp: null, sourceClock: 'page-wall',
            receivedMonoMs: null, wallMs: time.wallMs, logicalMs: time.logicalMs,
            anchorId: time.anchorId, uncertaintyMs: time.uncertaintyMs, resolutionMs: 1,
          },
          ids: { actionId: host ? host.actionId : null, opId: op.opId || null, frameId: null, traceIdHash: null, requestKey: null },
          sourceRef: { networkSessionId: session.networkSessionId, networkSeq: null, visualSessionId: null, frameSeq: null },
          provenance: {
            producer: 'page-declared', sourceKind: 'page-ledger', adapterId: null, adapterVersion: null,
            trust: host ? 'host-observed' : 'page-declared', evidenceIds: host ? [host.actionId] : [], rawHash: null,
          },
          payload: {
            opId: op.opId || null, opKind: op.kind || null, target: op.target || null,
            requestIds: Array.isArray(op.requestIds) ? [...op.requestIds] : [],
            appRequestIds: Array.isArray(op.requestIds) ? [...op.requestIds] : [],
          },
        });
      }
      for (const transition of net.ui || []) {
        const time = this.#dynamicPageTime(session, transition.atWallMs, transition.atMs);
        const cause = transition.cause && typeof transition.cause === 'object'
          ? { kind: transition.cause.kind || null, id: transition.cause.id || null }
          : null;
        // Independent DOM readback for the most common UI transitions (never the oracle).
        let causeVerified = false;
        if (cause && ['request', 'response', 'ws', 'sse', 'poll'].includes(cause.kind)) {
          if (transition.key === 'error') {
            causeVerified = Boolean(dom.error && dom.error.hidden === false && dom.error.text.length > 0);
          } else if (transition.key === 'cart.count') {
            causeVerified = dom.cartCount !== null && String(transition.to) === String(dom.cartCount);
          } else if (transition.key === 'order.status') {
            const label = { pending: '待支付', paid: '已支付', fulfilled: '已完成', cancelled: '已取消' }[String(transition.to)];
            causeVerified = Boolean(label && dom.orderStatus && dom.orderStatus.includes(label));
          }
        }
        if (causeVerified) session.pageBridge.domVerified += 1;
        push({
          domain: 'visual', kind: 'ui-transition', phase: 'end',
          ts: {
            timelineMs: time.timelineMs, sourceTimestamp: null, sourceClock: 'page-wall',
            receivedMonoMs: null, wallMs: time.wallMs, logicalMs: time.logicalMs,
            anchorId: time.anchorId, uncertaintyMs: time.uncertaintyMs, resolutionMs: 1,
          },
          ids: { actionId: null, opId: null, frameId: null, traceIdHash: null, requestKey: null },
          sourceRef: { networkSessionId: session.networkSessionId, networkSeq: null, visualSessionId: session.motionSessionId, frameSeq: null },
          provenance: {
            producer: 'page-declared', sourceKind: 'page-ledger', adapterId: null, adapterVersion: null,
            trust: 'page-declared', evidenceIds: [], rawHash: null,
          },
          payload: {
            key: transition.key || null, from: transition.from === undefined ? null : transition.from,
            to: transition.to === undefined ? null : transition.to,
            uiTransition: true, cause, causeVerified,
            causeEventId: null,
          },
        });
      }
    }
    return events;
  }

  /**
   * Bridge page app request ids (`t4-req-*`) to P0 events. P0 sanitizes correlation headers, so
   * this is a ledger + method/url/status/time MATCH, never a header cross-check: the result is
   * marked `appRequestIdSource='page-ledger-match'` and `headerVerified=false`, so the core can
   * only reach `observed`, never `explicit`.
   */
  #dynamicBridgeAppRequests(session, networkEvents, pageNet) {
    const map = new Map();
    if (!pageNet || !Array.isArray(pageNet.requests) || networkEvents.length === 0) return map;
    // Group P0 events per request (request/response/finished are separate immutable events).
    const groups = new Map();
    for (const event of networkEvents) {
      const key = [event.payload?.targetId ?? '', event.payload?.cdpSessionId ?? '', event.payload?.requestId ?? '', event.payload?.hopId ?? 0].join('\u0000');
      if (!groups.has(key)) groups.set(key, []);
      groups.get(key).push(event);
    }
    const requestGroups = [...groups.values()];
    for (const request of pageNet.requests) {
      const method = String(request.method || '').toUpperCase();
      const url = String(request.url || '');
      const wall = Number(request.atWallMs);
      if (!method || !url) continue;
      const pagePath = url.startsWith('/') ? url : null;
      const sameUrl = (eventUrl) => {
        if (!eventUrl) return false;
        if (eventUrl === url) return true;
        if (!pagePath) return false;
        try {
          const parsed = new URL(eventUrl);
          return parsed.pathname === pagePath.split('?')[0]
            && (!pagePath.includes('?') || (parsed.search || '') === '?' + pagePath.split('?').slice(1).join('?'));
        } catch { return String(eventUrl).endsWith(url); }
      };
      const matches = [];
      for (const group of requestGroups) {
        const sample = group.find((event) => String(event.payload?.method || '').toUpperCase() === method
          && sameUrl(String(event.payload?.url || '')));
        if (!sample) continue;
        let distance = 0;
        if (Number.isFinite(wall)) {
          const groupWall = Math.min(...group.map((event) => Number(event.ts?.wallMs)).filter((value) => Number.isFinite(value)));
          if (!Number.isFinite(groupWall)) continue;
          distance = Math.abs(groupWall - wall);
          if (distance > 5000) continue;
        }
        matches.push({ group, distance });
      }
      if (matches.length === 0) continue;
      // Repeated scenarios reuse the same URL: keep the CLOSEST group, and refuse a tie.
      matches.sort((left, right) => left.distance - right.distance);
      if (matches.length > 1 && matches[1].distance - matches[0].distance < 250) continue;
      const group = matches[0].group;
      const appRequestId = String(request.requestId || '');
      if (!appRequestId) continue;
      const preference = ['finished', 'failed', 'response', 'request', 'redirect', 'ws-handshake', 'ws-created'];
      let representative = group[0];
      for (const event of group) {
        const rank = preference.indexOf(event.payload?.phase);
        if (rank !== -1 && (preference.indexOf(representative.payload?.phase) === -1
          || rank < preference.indexOf(representative.payload?.phase))) representative = event;
      }
      for (const event of group) {
        const payload = event.payload || (event.payload = {});
        payload.appRequestId = appRequestId;
        payload.appRequestIds = [appRequestId];
        payload.appRequestIdSource = 'page-ledger-match';
        payload.headerVerified = false;
      }
      map.set(appRequestId, representative);
    }
    return map;
  }

  #dynamicSessionById(dynamicSessionId) {
    const id = String(dynamicSessionId);
    const candidates = [this.dynamic.session, ...this.dynamic.records].filter(Boolean);
    return candidates.find((record) => record.retained && record.dynamicSessionId === id) || null;
  }

  #dynamicCorrelationEvent(session, input) {
    const core = this.dynamic.core;
    const event = {
      version: 1,
      dynamicSessionId: session.dynamicSessionId,
      domain: input.domain,
      kind: input.kind,
      phase: input.phase === undefined ? null : input.phase,
      scopeId: this.scope.id,
      runtimeId: this.runtimeId,
      pageGeneration: session.pageGeneration,
      documentEpoch: input.documentEpoch === undefined ? session.documentEpoch : input.documentEpoch,
      targetId: this.page ? this.page.targetId : null,
      cdpSessionId: null,
      documentFrameId: null,
      ts: input.ts || {},
      ids: input.ids || {},
      sourceRef: input.sourceRef || {},
      provenance: input.provenance || {
        producer: 'host', sourceKind: 'runtime', adapterId: null, adapterVersion: null,
        trust: 'host-observed', evidenceIds: [], rawHash: null,
      },
      payload: input.payload || {},
      incomplete: Array.isArray(input.incomplete) ? input.incomplete : [],
      truncated: false,
    };
    return core ? core.normalizeDynamicEvent(event, {
      dynamicSessionId: session.dynamicSessionId, scopeId: this.scope.id, now: () => dynamicMonoNow(),
    }) : event;
  }

  #dynamicVisualEvents(session, limit = 200) {
    const frames = this.#dynamicFramesOf(session, { limit });
    const events = [];
    for (const frame of frames) {
      events.push(this.#dynamicCorrelationEvent(session, {
        domain: 'visual',
        kind: 'frame',
        phase: 'sample',
        ts: {
          timelineMs: Number.isFinite(frame.timelineMs) ? frame.timelineMs : null,
          sourceTimestamp: Number.isFinite(frame.sourceTimestamp) ? frame.sourceTimestamp : null,
          sourceClock: frame.sourceClock || session.config.source,
          receivedMonoMs: frame.receivedMonoMs,
          wallMs: null,
          logicalMs: null,
          anchorId: null,
          uncertaintyMs: frame.sourceTimestamp === null ? null : null,
          resolutionMs: null,
        },
        ids: { actionId: null, opId: null, frameId: frame.frameId, traceIdHash: null, requestKey: null },
        sourceRef: { networkSessionId: session.networkSessionId, networkSeq: null, visualSessionId: session.motionSessionId, frameSeq: frame.seq },
        payload: { frameId: frame.frameId, encoding: frame.encoding, sha256: frame.sha256, bytes: frame.bytesLength === undefined ? null : frame.bytesLength },
        incomplete: Array.isArray(frame.incomplete) ? frame.incomplete : [],
      }));
    }
    return events;
  }

  #dynamicOperationEvents(session, limit = 200) {
    const listed = this.#dynamicQueryEvents(session, { domains: ['operation'], limit });
    const list = Array.isArray(listed) ? listed : [];
    return list.map((event) => this.#dynamicCorrelationEvent(session, {
      domain: 'operation',
      kind: event.kind,
      phase: event.phase,
      ts: event.ts || {},
      ids: event.ids || {},
      sourceRef: event.sourceRef || {},
      payload: event.payload || {},
      incomplete: event.incomplete || [],
    }));
  }

  #dynamicNetworkEvents(session, limit = 200) {
    if (!session.networkSessionId) return null;
    const current = this.net.session;
    if (!current || current.id !== session.networkSessionId) return null;
    let queried;
    try {
      // Take the NEWEST 200 events explicitly: `order` alone is not a guarantee that the page
      // selection starts at the high-water mark, and a long-lived P0 session can hold thousands.
      const pageLimit = Math.min(limit, 200);
      const highWater = Number.isInteger(this.net.seq) ? this.net.seq : 0;
      const sinceSeq = Math.max(0, highWater - (pageLimit - 1));
      queried = network.queryEvents(this.net, { sinceSeq, limit: pageLimit, view: 'full' });
    } catch { return null; }
    const list = queried && Array.isArray(queried.events) ? queried.events : [];
    return list.map((event) => {
      const wallMs = event.ts && Number.isFinite(event.ts.wallMs) ? event.ts.wallMs : null;
      const timelineMs = wallMs === null ? null : Math.max(0, wallMs - session.startedAt);
      return this.#dynamicCorrelationEvent(session, {
        domain: 'network',
        kind: event.kind || 'http',
        phase: event.phase || null,
        ts: {
          timelineMs,
          sourceTimestamp: event.ts && Number.isFinite(event.ts.cdpSeconds) ? event.ts.cdpSeconds : null,
          sourceClock: 'cdp-network',
          receivedMonoMs: null,
          wallMs,
          logicalMs: null,
          anchorId: null,
          uncertaintyMs: null,
          resolutionMs: null,
        },
        ids: {
          actionId: null, opId: null, frameId: null,
          traceIdHash: event.correlation && event.correlation.traceIdHash ? event.correlation.traceIdHash : null,
          requestKey: event.requestId ? {
            networkSessionId: session.networkSessionId,
            targetId: event.targetId === undefined ? null : event.targetId,
            cdpSessionId: event.cdpSessionId === undefined ? null : event.cdpSessionId,
            requestId: String(event.requestId),
            hopId: Number.isInteger(event.hopId) ? event.hopId : 0,
          } : null,
        },
        sourceRef: { networkSessionId: session.networkSessionId, networkSeq: event.seq, visualSessionId: null, frameSeq: null },
        payload: {
          kind: event.kind, phase: event.phase, method: event.method || null, url: event.url || null,
          status: event.status === undefined ? null : event.status,
          seq: Number.isInteger(event.seq) ? event.seq : null,
          targetId: event.targetId === undefined ? null : event.targetId,
          cdpSessionId: event.cdpSessionId === undefined ? null : event.cdpSessionId,
          requestId: event.requestId === undefined ? null : event.requestId,
          hopId: Number.isInteger(event.hopId) ? event.hopId : 0,
          durationMs: event.timing && Number.isFinite(event.timing.totalMs) ? event.timing.totalMs : null,
          // WS/SSE payload fragments so a page-declared `cause.id` (e.g. ws-frame-1) can be matched.
          text: event.text === undefined ? null : event.text,
          data: event.data === undefined ? null : event.data,
          message: event.message === undefined ? null : event.message,
          redirect: event.redirect && typeof event.redirect === 'object' ? {
            from: event.redirect.from === undefined ? null : event.redirect.from,
            to: event.redirect.to === undefined ? null : event.redirect.to,
            status: event.redirect.status === undefined ? null : event.redirect.status,
            fromSeq: Number.isInteger(event.redirect.fromSeq) ? event.redirect.fromSeq : null,
            toSeq: Number.isInteger(event.redirect.toSeq) ? event.redirect.toSeq : null,
          } : null,
        },
        provenance: {
          producer: 'p0-network', sourceKind: 'cdp-network', adapterId: null, adapterVersion: null,
          trust: 'cdp-observed', evidenceIds: [], rawHash: null,
        },
      });
    });
  }

  /** `browser_dynamic_correlate` (contract §2.5 / §3.5). Pure query: no ensure, no lease. */
  async dynamicCorrelate(args) {
    const correlateStartedAt = Date.now();
    assertDynamicKeys(args, ['dynamicSessionId', 'motionSessionId', 'networkSessionId', 'window', 'directions',
      'eventIds', 'includeTemporal', 'beforeMs', 'afterMs', 'limit', 'cursor'], 'dynamic_correlate');
    if (typeof args.dynamicSessionId !== 'string' || args.dynamicSessionId === '') {
      throw new BrowserError('DYNAMIC_INVALID_ARGUMENT', 'dynamicSessionId 必须是非空字符串', { field: 'dynamicSessionId' });
    }
    const session = this.#dynamicSessionById(args.dynamicSessionId);
    if (!session) throw new BrowserError('DYNAMIC_SESSION_NOT_FOUND', '动态会话不存在或不属于本 scope', { dynamicSessionId: args.dynamicSessionId });
    const motionSessionId = args.motionSessionId === undefined ? null : args.motionSessionId;
    const networkSessionId = args.networkSessionId === undefined ? null : args.networkSessionId;
    if (!motionSessionId && !networkSessionId) {
      throw new BrowserError('DYNAMIC_INVALID_ARGUMENT', '首次查询必须显式给 motionSessionId 或 networkSessionId', { fields: ['motionSessionId', 'networkSessionId'] });
    }
    if (motionSessionId !== null && motionSessionId !== session.motionSessionId) {
      throw new BrowserError('DYNAMIC_SESSION_NOT_FOUND', 'motionSessionId 不属于该动态会话', { motionSessionId });
    }
    if (networkSessionId !== null && networkSessionId !== session.networkSessionId) {
      throw new BrowserError('DYNAMIC_SESSION_NOT_FOUND', 'networkSessionId 不属于该动态会话', { networkSessionId });
    }
    const window = args.window === undefined ? null : normalizeDynamicWindow(args.window);
    let directions = null;
    if (args.directions !== undefined) {
      if (!Array.isArray(args.directions) || args.directions.length === 0) {
        throw new BrowserError('DYNAMIC_INVALID_ARGUMENT', 'directions 必须是非空数组', { field: 'directions' });
      }
      directions = [];
      for (const direction of args.directions) {
        if (!DYNAMIC_DIRECTIONS.includes(direction)) {
          throw new BrowserError('DYNAMIC_INVALID_ARGUMENT', 'direction 不合法', { field: 'directions', allowed: [...DYNAMIC_DIRECTIONS] });
        }
        if (!directions.includes(direction)) directions.push(direction);
      }
    }
    const eventIds = dynamicIdList(args.eventIds, 'eventIds', T4_LIMITS.maxIds);
    const includeTemporal = args.includeTemporal === undefined ? false : args.includeTemporal;
    if (typeof includeTemporal !== 'boolean') throw new BrowserError('DYNAMIC_INVALID_ARGUMENT', 'includeTemporal 必须是布尔值', { field: 'includeTemporal' });
    let beforeMs = T4_LIMITS.correlationBeforeMs;
    let afterMs = T4_LIMITS.correlationAfterMs;
    if (args.beforeMs !== undefined) {
      beforeMs = dynamicFinite(args.beforeMs, 'beforeMs');
      if (beforeMs < 0 || beforeMs > T4_LIMITS.maxCorrelationBeforeMs) throw new BrowserError('DYNAMIC_INVALID_ARGUMENT', 'beforeMs 越界', { field: 'beforeMs' });
    }
    if (args.afterMs !== undefined) {
      afterMs = dynamicFinite(args.afterMs, 'afterMs');
      if (afterMs < 0 || afterMs > T4_LIMITS.maxCorrelationAfterMs) throw new BrowserError('DYNAMIC_INVALID_ARGUMENT', 'afterMs 越界', { field: 'afterMs' });
    }
    let limit = 50;
    if (args.limit !== undefined) limit = dynamicInteger(args.limit, 'limit', 1, 200);
    if (args.cursor !== undefined && (typeof args.cursor !== 'string' || args.cursor === '' || Buffer.byteLength(args.cursor, 'utf8') > 2048)) {
      throw new BrowserError('DYNAMIC_INVALID_ARGUMENT', 'cursor 必须是 ≤2048 字节的非空字符串', { field: 'cursor' });
    }
    const core = await this.#dynamicLoadCore();
    // Authorized page-ledger snapshot (read-only, documented fields only). A page without `__t4`
    // is reported as sourceUnavailable; it is never turned into a fake empty ledger.
    let page = null;
    // Read the page ledger whenever THIS runtime still owns the SAME page/document as the session,
    // including a retained (stopped/duration-expired) session: stored correlation must stay usable
    // after stop. The evaluate goes to the MAIN world (no isolated contextId), so `window.__t4` is
    // the same object `browser_eval` sees.
    const pageIdentityMatches = Boolean(this.page)
      && (session.pageGeneration === null || session.pageGeneration === undefined || session.pageGeneration === this.page.generation)
      && (session.documentEpoch === null || session.documentEpoch === undefined || session.documentEpoch === this.t2.documentEpoch);
    if ((session.captureVisual || session.networkSessionId) && this.page && pageIdentityMatches) {
      try { page = await this.#dynamicPageSnapshot(session); } catch { page = null; }
    } else if ((session.captureVisual || session.networkSessionId) && this.page) {
      session.pageBridge.lastError = { code: 'page-identity-changed', message: 'documentEpoch/pageGeneration differs from the session' };
    }
    const epochMismatch = page !== null && session.documentEpoch !== this.t2.documentEpoch;
    if (epochMismatch && !session.issues.includes('document-changed-since-start')) {
      session.issues.push('document-changed-since-start');
    }
    const pageEvents = page ? this.#dynamicPageEvents(session, page.snapshot) : [];
    const pageOperations = pageEvents.filter((event) => event.domain === 'operation');
    const pageVisuals = pageEvents.filter((event) => event.domain === 'visual');
    const networkEvents = this.#dynamicNetworkEvents(session);
    const appRequestMap = networkEvents ? this.#dynamicBridgeAppRequests(session, networkEvents, page && page.snapshot.net) : new Map();
    // DC05: project P0 redirect parent endpoints into the RequestKey form the core joins on.
    if (networkEvents) {
      const bySeq = new Map();
      for (const event of networkEvents) {
        if (Number.isInteger(event.payload?.seq)) bySeq.set(event.payload.seq, event);
      }
      for (const event of networkEvents) {
        const redirect = event.payload?.redirect;
        if (!redirect || !Number.isInteger(redirect.fromSeq)) continue;
        const parent = bySeq.get(redirect.fromSeq);
        const key = parent && parent.ids && parent.ids.requestKey;
        if (!key) continue;
        event.payload.redirectFromRequestKey = [
          key.networkSessionId ?? '', key.targetId ?? '', key.cdpSessionId ?? '',
          key.requestId, Number.isInteger(key.hopId) ? key.hopId : 0,
        ].join('\u0000');
      }
    }
    // DC04: the fixture has no retryFrom parent edge. Link a retry POST that happens AFTER the
    // visible error transition to that page-declared error event; the core can then only reach
    // observed (causeVerified stays false), never confirmed-causal.
    const errorVisual = pageVisuals
      .filter((event) => event.payload && event.payload.key === 'error')
      .sort((left, right) => (left.ts.timelineMs ?? 0) - (right.ts.timelineMs ?? 0))
      .pop() || null;
    if (errorVisual && networkEvents) {
      for (const event of networkEvents) {
        const payload = event.payload || {};
        if (String(payload.method || '').toUpperCase() !== 'POST') continue;
        if (!String(payload.url || '').includes('/api/t4/orders')) continue;
        if (payload.phase !== 'request') continue;
        if (!Number.isFinite(event.ts.timelineMs) || !Number.isFinite(errorVisual.ts.timelineMs)) continue;
        if (event.ts.timelineMs > errorVisual.ts.timelineMs) {
          payload.causeEventId = errorVisual.eventId;
          payload.causeVerified = false;
        }
      }
    }
    // Resolve page-declared UI causes to the P0 endpoint by the same ledger match; verification
    // still requires the DOM readback recorded above.
    for (const visualEvent of pageVisuals) {
      const cause = visualEvent.payload && visualEvent.payload.cause;
      if (!cause || !cause.id) continue;
      let endpoint = null;
      if (cause.kind === 'request' || cause.kind === 'response') {
        endpoint = appRequestMap.get(String(cause.id)) || null;
      } else if (networkEvents) {
        // WS frame / SSE event / poll endpoint: match the page-declared id or the closest event
        // of the same kind; a non-unique match stays unresolved instead of guessing.
        const kind = cause.kind;
        const wanted = String(cause.id);
        const candidates = networkEvents.filter((event) => {
          const payload = event.payload || {};
          if (kind === 'ws') return payload.kind === 'ws' || event.kind === 'ws';
          if (kind === 'sse') return payload.kind === 'sse' || event.kind === 'sse';
          if (kind === 'poll') return String(payload.method || '').toUpperCase() === 'GET'
            && String(payload.url || '').includes('/api/t4/orders/');
          return false;
        });
        const byId = candidates.filter((event) => {
          const payload = event.payload || {};
          const text = JSON.stringify(payload);
          return text.includes(wanted) || String(payload.requestId || '').includes(wanted)
            || String(payload.url || '').includes(wanted);
        });
        const pool = byId.length === 1 ? byId : candidates;
        if (pool.length === 1) endpoint = pool[0];
        else if (pool.length > 1) {
          const visualTime = visualEvent.ts.timelineMs;
          const timed = pool
            .filter((event) => Number.isFinite(event.ts.timelineMs) && Number.isFinite(visualTime))
            .map((event) => ({ event, distance: Math.abs(event.ts.timelineMs - visualTime) }))
            .sort((left, right) => left.distance - right.distance);
          if (timed.length && (timed.length === 1 || timed[1].distance - timed[0].distance > 50)) endpoint = timed[0].event;
        }
      }
      if (endpoint) {
        visualEvent.payload.causeEventId = endpoint.eventId;
        visualEvent.payload.causeVerified = visualEvent.payload.causeVerified === true && Boolean(endpoint);
      }
    }
    const operationEvents = [...this.#dynamicOperationEvents(session), ...pageOperations];
    const frameEvents = session.captureVisual ? this.#dynamicVisualEvents(session) : [];
    const visualEvents = [...frameEvents, ...pageVisuals];
    const operationIntegrity = (() => { try { return session.events ? session.events.integrity() : null; } catch { return null; } })();
    const visualIntegrity = session.frames ? this.#dynamicIntegrity(session) : null;
    const networkIntegrity = (() => { try { return this.net ? network.integrityView?.(this.net) ?? null : null; } catch { return null; } })();
    const pageSource = page
      ? {
        available: true, provenance: 'page-declared',
        anchorId: page.anchor ? page.anchor.anchorId : null,
        uncertaintyMs: page.anchor ? page.anchor.uncertaintyMs : null,
        documentEpoch: this.t2.documentEpoch,
        epochMatchesSession: !epochMismatch,
      }
      : {
        available: false, reason: 'page-ledger-unavailable',
        error: session.pageBridge.lastError || null,
      };
    if (!page && session.captureVisual && visualIntegrity && !visualIntegrity.issues.includes('page-ledger-unavailable')) {
      visualIntegrity.issues.push('page-ledger-unavailable');
    }
    const input = {
      dynamicSessionId: session.dynamicSessionId,
      scopeId: this.scope.id,
      sources: {
        operation: {
          events: operationEvents,
          integrity: { ...(operationIntegrity || {}), pageSource },
          highWater: Math.max(session.events ? session.events.highWater : 0, pageOperations.length),
        },
        visual: session.captureVisual ? {
          events: visualEvents,
          integrity: { ...(visualIntegrity || {}), pageSource },
          highWater: Math.max(session.frames ? session.frames.highWater : 0, pageVisuals.length),
        } : null,
        network: networkEvents ? {
          events: networkEvents,
          integrity: { ...(networkIntegrity || {}), pageSource: page && page.snapshot.net ? { available: true, provenance: 'page-declared' } : { available: false, reason: 'page-ledger-unavailable' } },
          highWater: this.net.seq,
        } : null,
      },
      includeTemporal,
      beforeMs,
      afterMs,
      limit,
    };
    if (window) input.window = window;
    if (directions) input.directions = directions;
    if (eventIds) input.eventIds = eventIds;
    if (args.cursor !== undefined) input.cursor = args.cursor;
    let result;
    try {
      result = core.correlateDynamic(input);
    } catch (error) {
      throw asBrowserError(error);
    }
    this.#dynamicTouch('dynamic.correlate', { verdict: result && result.verdict ? result.verdict.status : null });
    // Core diagnostics are authoritative (same-domain prefilter + real compare counts). The Host
    // keeps its own upper-bound estimate only under an explicitly named field, never as `estimated`.
    const coreDiagnostics = result && result.diagnostics && typeof result.diagnostics === 'object'
      ? result.diagnostics : null;
    const hostUpperBoundPairComparisons =
      operationEvents.length * operationEvents.length
      + visualEvents.length * visualEvents.length
      + (networkEvents ? networkEvents.length * networkEvents.length : 0)
      + operationEvents.length * visualEvents.length
      + visualEvents.length * (networkEvents ? networkEvents.length : 0)
      + operationEvents.length * (networkEvents ? networkEvents.length : 0);
    const diagnostics = {
      sources: {
        operation: operationEvents.length,
        visual: visualEvents.length,
        network: networkEvents ? networkEvents.length : 0,
        frames: session.frames ? session.frames.highWater : 0,
      },
      directions: (directions || DYNAMIC_DIRECTIONS).length,
      limit,
      window,
      beforeMs,
      afterMs,
      elapsedMs: Date.now() - correlateStartedAt,
      // Actual comparisons reported by the pure core (after the same-domain time-window prefilter).
      estimatedPairComparisons: coreDiagnostics ? coreDiagnostics.estimatedPairComparisons : null,
      pairComparisons: coreDiagnostics ? coreDiagnostics.pairComparisons : null,
      upperBoundPairComparisons: coreDiagnostics ? coreDiagnostics.upperBoundPairComparisons : null,
      directionComparisons: coreDiagnostics ? coreDiagnostics.directionComparisons : null,
      sameDomainPrefilter: coreDiagnostics ? coreDiagnostics.sameDomainPrefilter : null,
      candidateBudgetExhausted: coreDiagnostics ? coreDiagnostics.candidateBudgetExhausted : null,
      // Host-only upper bound, explicitly labelled; never presented as the core's actual count.
      hostUpperBoundPairComparisons,
      maxCandidateCompares: coreDiagnostics ? coreDiagnostics.maxCandidateCompares : T4_LIMITS.maxCandidateCompares,
      // Never hard-coded: the value actually enforced by the loaded core.
      enforcedMaxCandidateCompares: coreDiagnostics
        ? coreDiagnostics.maxCandidateCompares
        : (this.dynamic.core && this.dynamic.core.T4_LIMITS ? this.dynamic.core.T4_LIMITS.maxCandidateCompares : null),
      pairCount: Array.isArray(result && result.pairs) ? result.pairs.length : null,
      truncated: result && result.truncated === true,
      incomplete: result && Array.isArray(result.incomplete) ? [...result.incomplete] : [],
    };
    return {
      ok: true,
      ...result,
      pageSource: pageSource,
      diagnostics,
      evidence: this.#dynamicEvidence('dynamic.correlate', session),
    };
  }

  #dynamicEmptyRestoreStatus() {
    return { status: 'not-needed', attempted: [], restored: [], failed: [], conflicts: [], lastObserved: [] };
  }

  /** Sessions of this scope that still hold a control obligation (any target written). */
  #dynamicControlObligations() {
    const seen = new Set();
    const list = [];
    for (const session of [this.dynamic.session, ...this.dynamic.records]) {
      if (!session || !session.control || session.control.targets.length === 0) continue;
      if (seen.has(session.dynamicSessionId)) continue;
      seen.add(session.dynamicSessionId);
      list.push(session);
    }
    // Unwind the provable Host control chain newest-write-first across sessions.
    list.sort((left, right) => {
      const lastWrite = (session) => Math.max(0, ...session.control.targets.map((entry) => Number(entry.lastWrittenAtMonoMs) || 0));
      return lastWrite(right) - lastWrite(left);
    });
    return list;
  }

  #dynamicAggregateRestore(restores) {
    if (!restores.length) return this.#dynamicEmptyRestoreStatus();
    const status = {
      status: 'restored', attempted: [], restored: [], failed: [], conflicts: [], lastObserved: [],
    };
    for (const entry of restores) {
      status.attempted.push(...(entry.attempted || []));
      status.restored.push(...(entry.restored || []));
      status.failed.push(...(entry.failed || []));
      status.conflicts.push(...(entry.conflicts || []));
      status.lastObserved.push(...(entry.lastObserved || []));
    }
    if (status.failed.length > 0) status.status = 'failed';
    else if (status.conflicts.length > 0 && status.restored.length === 0) status.status = 'conflict';
    else if (status.restored.length === 0) status.status = 'not-needed';
    else status.status = status.conflicts.length ? 'partial' : 'restored';
    return status;
  }

  /** Restore EVERY unfinished control obligation in this scope (running/stopped/retained). */
  async #dynamicRestoreAll(reason) {
    const sessions = this.#dynamicControlObligations();
    const restores = [];
    for (const session of sessions) {
      let status = null;
      try { status = await this.#dynamicRestoreControl(session, reason); } catch (error) {
        status = {
          status: 'failed', attempted: [], restored: [],
          failed: [{ targetId: '*', code: 'DYNAMIC_RESTORE_FAILED', reason: String((error && error.message) || error) }],
          conflicts: [], lastObserved: [],
        };
      }
      restores.push({
        dynamicSessionId: session.dynamicSessionId,
        motionSessionId: session.motionSessionId,
        attempted: Array.isArray(status?.attempted) ? status.attempted : [],
        restored: Array.isArray(status?.restored) ? status.restored : [],
        failed: Array.isArray(status?.failed) ? status.failed : [],
        conflicts: Array.isArray(status?.conflicts) ? status.conflicts : [],
        lastObserved: Array.isArray(status?.lastObserved) ? status.lastObserved : [],
        status: status?.status || 'failed',
      });
    }
    return restores;
  }

  /** Best-effort restore of this session's control fields, reusable on stop/duration/close. */
  async #dynamicFinalRestore(session, reason) {
    if (!session || !session.control || session.control.targets.length === 0) return null;
    let status = null;
    try { status = await this.#dynamicRestoreControl(session, reason); } catch { status = null; }
    // Keep the targets so a later explicit restore on the retained session is still reachable and
    // idempotent: the last-written state becomes the restored original.
    if (status && status.status === 'restored') {
      for (const entry of session.control.targets) {
        if (entry.original) entry.lastWritten = { ...entry.original };
      }
    }
    return status;
  }

  /** Plugin unload: stop the sink and release every frame/event store of this scope. */
  async disposeDynamic() {
    const restores = await this.#dynamicRestoreAll('dispose');
    this.dynamic.disposeRestore = { restores, restoreStatus: this.#dynamicAggregateRestore(restores) };
    await this.#dynamicTeardown('dispose');
  }

  /** Best-effort teardown used by close/dispose: stop the visual sink and restore nothing here. */
  async #dynamicTeardown(reason) {
    const session = this.dynamic.session;
    try { if (session) await this.#dynamicDetachSink(session, reason); } catch { /* best effort */ }
    this.dynamic.session = null;
    this.dynamic.sink = null;
    for (const record of this.dynamic.records) {
      try { if (record.frames) record.frames.dispose(); } catch { /* best effort */ }
      try { if (record.events) record.events.dispose(); } catch { /* best effort */ }
      record.frames = null;
      record.events = null;
      record.imageCache.clear();
    }
    this.dynamic.records = [];
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
        throw new BrowserError('NET_OUTPUT_WRITE_FAILED', '证据写入失败', {
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
    // The panel's annotations belong to the document that was just replaced (docs/viewport-control.md
    // §11.2): rotate the navigation token and drop the stored document with it, so a late publish
    // can only be refused as `annotation-context-stale`.
    this.#annotationRotate('document');
    // A new document has no keys held and no known cursor: keeping them would synthesize modifiers
    // from a page that no longer exists (docs/tools.md, browser_input).
    this.resetInputState();
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
    // P0-E §5: refs are globally unique across sibling tabs, while each Runtime keeps its own
    // resolution table. The registry allocator is a synchronous counter, not a page queue.
    if (this.registry && typeof this.registry.allocateRef === 'function') return this.registry.allocateRef();
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
        // What the *page* observed, not what CDP accepted (docs/web/input-delivery.md):
        // `verified:false` means no probe could be installed, so nothing is claimed either way.
        delivery: draft.dispatch.delivery === undefined ? { verified: false, delivered: null } : draft.dispatch.delivery,
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
    const gesture = async () => {
      await this.send('Input.dispatchMouseEvent', { type: 'mouseMoved', x, y, button: 'none', buttons: 0, modifiers: modifierMask }, signal);
      draft.dispatch.started = true;
      draft.dispatch.eventSource = 'cdp-input';
      for (let index = 1; index <= clickCount; index += 1) {
        await this.send('Input.dispatchMouseEvent', { type: 'mousePressed', x, y, button, buttons: mask, clickCount: index, modifiers: modifierMask }, signal);
        draft.dispatch.eventCount += 1;
        await this.send('Input.dispatchMouseEvent', { type: 'mouseReleased', x, y, button, buttons: mask, clickCount: index, modifiers: modifierMask }, signal);
        draft.dispatch.eventCount += 1;
      }
    };
    // Dispatch, then ask the page what it actually saw. A CDP dispatch that returns is not proof of
    // delivery; the page is the only witness (docs/web/input-delivery.md).
    const epoch = this.documentEpoch();
    let verdict = { delivered: false, seen: [] };
    let verified = true;
    let attempts = 0;
    while (attempts < 2) {
      // The initial dispatch can be unverified. A retry needs a new witness in the same document.
      if (attempts > 0 && this.documentEpoch() !== epoch) break;
      const installed = await this.#installInputProbe(signal);
      if (attempts > 0 && (!installed || this.documentEpoch() !== epoch)) break;
      attempts += 1;
      await gesture();
      const probe = installed && await this.#readInputProbeSettled(INPUT_DELIVERY_CLICK_GROUPS, signal);
      if (!probe?.present) { verified = false; break; }
      verdict = inputDeliveryVerdict(probe.seen, INPUT_DELIVERY_CLICK_GROUPS);
      // T2 moves the pointer before clicking. Movement alone is not a partial button gesture.
      const sawGesture = probe.seen.some((type) => type !== 'mousemove' && type !== 'pointermove');
      if (verdict.delivered || sawGesture || attempts === 2) break;
      await this.activate(signal).catch(() => false);
    }
    let recovery = null;
    if (this.host?.display === 'headless' && this.documentEpoch() === epoch
      && verified && attempts === 2 && !verdict.delivered && verdict.seen.length === 0) {
      const healed = await this.#redispatchAfterRecycle(INPUT_DELIVERY_CLICK_GROUPS, gesture, signal);
      if (healed) {
        recovery = 'document-recycled';
        attempts += 1;
        verdict = healed;
      }
    }
    draft.dispatch.delivery = {
      verified, delivered: verified ? verdict.delivered : null, attempts, seen: verdict.seen,
      ...(recovery ? { recovery } : {}),
    };
    if (verified && !verdict.delivered) {
      throw new BrowserError('INPUT_NOT_DELIVERED',
        '点击事件未完整送达页面：页面未观察到全部按下和释放事件',
        {
          attempts,
          seen: verdict.seen,
          missing: verdict.missing,
          button,
          point: { x, y },
          hint: (recovery === 'document-recycled'
            ? '自动重建文档后仍未确认点击完整送达，请检查页面状态。'
            : '页面未确认收到完整点击，请检查当前标签的状态。'),
        });
    }
    draft.dispatch.completed = true;
    return { x, y };
  }

  /**
   * Rebuild this page's document after a dispatch the page never observed.
   *
   * Measured on douyin (docs/web/input-delivery.md): a document can keep answering `Runtime.evaluate`,
   * painting and running at 60 fps while **every** synthetic `Input.*` event is dropped — including
   * events dispatched straight to that target's own CDP session, with no plugin code involved.
   * `Page.bringToFront` and `Target.activateTarget` both return success without changing where the
   * input goes, and `Page.reload` of the same document does not restore it either. Loading a
   * different document and coming back does, because the renderer/document is rebuilt.
   *
   * This is only attempted when the failed gesture produced **no** page event at all: nothing
   * happened, so nothing can be replayed twice. Returns false when the page has no URL to return to
   * (about:blank / error page) or the round trip did not commit.
   */
  async #recycleDocumentForInput(signal) {
    const url = this.url;
    if (!url || url === 'about:blank' || url.startsWith('chrome-error://')) return false;
    try {
      await validateTarget(url, { origins: [...this.origins], signal });
    } catch { return false; }
    const waitCommit = async (navigate, expectUrl) => {
      const waiter = this.#commitWaiter(
        (message) => message.method === 'Page.frameNavigated'
          && message.params.frame.parentId === undefined
          // Match the *expected* document, not merely "some main frame": a late commit from the
          // about:blank hop would otherwise satisfy the wait and we would replay the gesture into
          // the document that is about to be replaced (measured: the handler ran, then the reload
          // erased its effect, so the click looked delivered but did nothing).
          && (expectUrl === 'about:blank'
            ? String(message.params.frame.url || '') === 'about:blank'
            : String(message.params.frame.url || '').startsWith(expectUrl)),
        { signal },
      );
      try {
        await navigate();
        await waiter.promise;
        return true;
      } catch {
        return false;
      } finally {
        waiter.dispose();
      }
    };
    const away = await waitCommit(() => this.send('Page.navigate', { url: 'about:blank' }, signal), 'about:blank');
    if (!away) return false;
    const back = await waitCommit(() => this.send('Page.navigate', { url }, signal), url);
    if (!back) return false;
    // A replayed gesture must land on a document that is actually ready: clicking at commit time
    // hits elements whose own listeners are not attached yet (measured: the page observed the
    // press/release but its click handler never ran). Bounded wait, never longer than the retry.
    const readyDeadline = Date.now() + 2500;
    while (Date.now() < readyDeadline) {
      const state = await this.send('Runtime.evaluate', {
        expression: 'document.readyState', returnByValue: true,
      }, signal).catch(() => null);
      if (state?.result?.value === 'complete') break;
      await abortable(delay(100), this.#effectiveSignal(signal));
    }
    await this.refreshMetadata(signal).catch(() => {});
    // Only claim a heal when the browser really came back to the same document.
    return !this.url.startsWith('chrome-error://') && this.url.startsWith(url);
  }

  /**
   * One extra dispatch after rebuilding the document, only for a gesture that never landed.
   * Returns the new verdict, or null when the document could not be rebuilt (then the caller keeps
   * the original "not delivered" answer instead of inventing a success).
   */
  async #redispatchAfterRecycle(groups, dispatch, signal) {
    if (!(await this.#recycleDocumentForInput(signal))) return null;
    if (!(await this.#installInputProbe(signal))) return null;
    await dispatch();
    const probe = await this.#readInputProbeSettled(groups, signal);
    if (!probe?.present) return null;
    return inputDeliveryVerdict(probe.seen, groups);
  }

  /**
   * Read the probe, giving a busy renderer one more chance to dispatch the input first.
   *
   * A busy renderer may have processed only part of the gesture when the first snapshot arrives.
   * Keep recording until the bounded follow-up read, or clean up immediately if all groups matched.
   */
  async #readInputProbeSettled(groups, signal) {
    const first = await this.#readInputProbe(false, signal);
    if (!first?.present) return first;
    if (!inputDeliveryVerdict(first.seen, groups).delivered) {
      await abortable(delay(180), this.#effectiveSignal(signal));
      return this.#readInputProbe(true, signal);
    }
    await this.#readInputProbe(true, signal);
    return first;
  }

  /** Install the one-shot delivery probe in the current document (best effort). */
  async #installInputProbe(signal) {
    try {
      const result = await this.send('Runtime.evaluate', { expression: INPUT_PROBE_INSTALL_FN, returnByValue: true }, signal);
      return result?.result?.value?.installed === true;
    } catch { return false; }
  }

  async #readInputProbe(remove, signal) {
    try {
      const result = await this.send('Runtime.evaluate', {
        expression: `${INPUT_PROBE_READ_FN}(${remove})`, returnByValue: true,
      }, signal);
      const value = result?.result?.value;
      return value && Array.isArray(value.seen) ? { present: value.present === true, seen: value.seen } : null;
    } catch { return null; }
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
    // T4: restore EVERY unfinished control (retained included) while the page is still alive.
    try {
      const restores = await this.#dynamicRestoreAll('page-closed');
      this.dynamic.closeRestore = { restores, restoreStatus: this.#dynamicAggregateRestore(restores) };
    } catch { /* best effort */ }
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

    // Web T4: the page close ends the screencast correlation but NOT the stored evidence. The sink
    // is detached/flushed and the session becomes stopped; frame stores stay readable (observe is a
    // pure query and must not require a page). Only plugin teardown releases them.
    try {
      const dynamicSession = this.dynamic.session;
      if (dynamicSession) await this.#dynamicDetachSink(dynamicSession, 'page-closed');
      this.dynamic.session = null;
      this.dynamic.sink = null;
    } catch { /* evidence only */ }
    // Teardown must never construct the lazily loaded Web chain (A14): stop only what exists.
    if (this.#frames) this.#frames.stop();
    if (this.#audio) this.#audio.reset('page-closed');
    // Network collector teardown: release held requests (never leave a paused request behind),
    // stop collecting, drop child-session bookkeeping. Exported evidence files stay on disk.
    try { await this.#netReleaseAllHeld(); } catch { /* ignore */ }
    try { await this.#netDisarmAutoAttach(); } catch { /* ignore */ }
    this.netTargets.clear();
    this.netReq.clear();
    this.netHops.clear();
    this.netCacheHits.clear();
    if (this.#net) this.#net.stop();
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
    // (docs/viewport-control.md, docs/viewport-control.md): x/y and the canvas origin reset
    // to 0 (C=S=0, O=0), the observation is dropped, and the revision moves because that *is* a
    // content change (never silently reuse the old position).
    if (this.viewObserveTimer) { clearTimeout(this.viewObserveTimer); this.viewObserveTimer = 0; }
    this.viewObserveDue = [];
    this.viewObserving = false;
    this.viewObserveAt = 0;
    const hadViewPosition = this.view.x !== 0 || this.view.y !== 0
      || this.view.canvasX !== 0 || this.view.canvasY !== 0 || this.observed !== null;
    this.view.x = 0;
    this.view.y = 0;
    this.view.canvasX = 0;
    this.view.canvasY = 0;
    this.observed = null;
    this.viewOriginId = null;
    if (hadViewPosition) this.view.revision += 1;
    this.viewerUntil = 0;
    this.viewerSockets = 0;
    // Refs never survive a close/eviction/rebuild (contract §3.2).
    this.#t2BumpDocumentEpoch();
    try { this.registry?.onRuntimeClosed?.(this); } catch { /* projection only */ }

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

export function headerValue(headers, name) {
  const raw = headers ? headers[name] : undefined;
  if (raw === undefined || raw === null) return undefined;
  if (Array.isArray(raw)) return raw.length ? String(raw[0]) : undefined;
  return String(raw);
}

/**
 * Resolve one session id (optionally with the Agent's own `exec.agent.session.header.cwd`) to a
 * scope. The cwd is only a *lookup hint*: the canonical workspace id always comes from the DSH
 * workspace registry's exact realpath match. Absolute paths never leave this function.
 */

/** A fresh (mutable) copy of the unassigned scope so a root dimension can be attached. */
export function UNSCOPED_SCOPE_FACTORY() { return { key: UNASSIGNED_SCOPE.key, scope: UNASSIGNED_SCOPE.scope }; }

export class RuntimeRegistry {
  constructor({ log, ctx, origins, services = null, maxPages = MAX_PAGES_DEFAULT, idleMs = IDLE_MS_DEFAULT, maxEntries = MAX_ENTRIES_DEFAULT, viewerTtlMs = VIEWER_TTL_MS }) {
    this.log = log;
    this.ctx = ctx;
    /** Host service lookup (roster/membership proofs). Injected, never reached for directly. */
    this.services = services;
    this.origins = origins;
    this.maxPages = maxPages;
    this.idleMs = idleMs;
    this.maxEntries = maxEntries;
    this.viewerTtlMs = viewerTtlMs;
    this.maxPopupChildren = MAX_POPUP_CHILDREN_DEFAULT;
    this.entries = new Map();
    /** Workspace-group GUI projection revisions and bounded notices (popup internal tabs). */
    this.viewsRevision = new Map();
    this.popupNotices = new Map();
    /** P0-E lifecycle audit (TOOL-P0-01/P1-05): bounded per-workspace close history. */
    this.recentClosed = new Map();
    this.noticesLimit = POPUP_NOTICES_LIMIT;
    this.closedHistoryLimit = CLOSED_HISTORY_LIMIT;
    /** P0-E: per-Agent-session selected tab (workspaceKey + sessionId -> {tabId,...}). */
    this.selectedBySession = new Map();
    /** P0-E/T2: one monotonic ref allocator across all tabs of this registry. */
    this.nextGlobalRef = 1;
    /** provider -> BrowserHost. A provider only gets a host once its driver exists (§6). */
    this.hosts = new Map();
    /** base scope key -> provider that most recently used it (GUI/session fallback, §16 open item 2). */
    this.providerByBaseKey = new Map();
    this.reservations = 0;
    /** rootSessionId -> entry key of the last real interaction in that root (never cross-root). */
    this.recentByRoot = new Map();
    this.disposed = false;
    this.sweeping = false;
    this.sweepTimer = setInterval(() => { this.sweep().catch(() => {}); }, Math.max(1000, Math.min(60000, Math.floor(idleMs / 4))));
    this.sweepTimer.unref?.();
  }

  /**
   * Pages across **all** provider hosts. The page budget stays one global `maxPages`: splitting
   * hosts must never multiply the ceiling, so every budget check compares this sum.
   */
  get pageCount() {
    let total = 0;
    for (const host of this.hosts.values()) total += host.pageCount;
    return total;
  }

  /**
   * Compatibility accessor for host-idle checks only. It can never hand out another provider's host:
   * a question about a non-chrome provider must go through `hostFor(provider)`.
   */
  get host() { return this.hosts.get(DEFAULT_RUNTIME_PROVIDER); }

  /**
   * Test/stepper seam for the default provider slot only — retained **solely** for the existing
   * A12 stub injection in the acceptance suite; never use it on an execution path. It can never install a stub for another
   * provider: a non-default provider is addressed through `hostFor`/`browserHost` and must have a
   * real driver behind it.
   */
  set host(value) {
    if (value === undefined || value === null) {
      this.hosts.delete(DEFAULT_RUNTIME_PROVIDER);
      return;
    }
    this.hosts.set(DEFAULT_RUNTIME_PROVIDER, value);
  }

  /** Existing host for one provider, or undefined. Never creates, never substitutes chrome. */
  hostFor(provider = DEFAULT_RUNTIME_PROVIDER) {
    const id = typeof provider === 'string' && provider.length > 0 ? provider : DEFAULT_RUNTIME_PROVIDER;
    return this.hosts.get(id);
  }

  /**
   * Create (lazily) the host for one provider.
   *
   * A provider without a driver must never reach this point: `resolveWebDriver()` refuses
   * `pending`/`unsupported` providers before any execution, exactly so an "edge" label cannot end up
   * spawning Chrome (§8).
   */
  browserHost(provider = DEFAULT_RUNTIME_PROVIDER) {
    const id = typeof provider === 'string' && provider.length > 0 ? provider : DEFAULT_RUNTIME_PROVIDER;
    let host = this.hosts.get(id);
    if (!host) {
      host = new BrowserHost(this.log, { provider: id });
      this.hosts.set(id, host);
    }
    return host;
  }

  /**
   * Provider identity for one resolved scope request.
   *
   * `binding` is reserved for an *explicit* provider (the caller already knows which browser it
   * means). Everything else resolves to "the provider that last touched this workspace" and is
   * reported as `recent`, even when only one provider exists — callers never have to guess.
   */
  providerFor(resolved) {
    const explicit = typeof resolved?.provider === 'string' && resolved.provider.length > 0
      ? resolved.provider
      : null;
    if (explicit !== null) return { provider: explicit, providerResolved: 'binding' };
    // The provider fallback is per (workspace, root): another root's last-used browser must never
    // become this root's routing decision for the same workspace.
    const recent = this.providerByBaseKey.get(providerIndexKey(resolved?.key, resolved?.rootSessionId));
    return {
      provider: typeof recent === 'string' && recent.length > 0 ? recent : DEFAULT_RUNTIME_PROVIDER,
      providerResolved: 'recent',
    };
  }

  /**
   * Provider facts for a response, so a fallback never looks like an exact match.
   * `resolved` (the lookup that produced the entry) wins: `binding` only when the caller named the
   * provider; every fallback reports `recent`, even with a single provider installed.
   */
  providerFacts(entry, resolved = null) {
    const providerResolved = resolved
      ? this.providerFor(resolved).providerResolved
      : (entry?.providerResolved === 'binding' ? 'binding' : 'recent');
    return {
      provider: entry?.provider ?? DEFAULT_RUNTIME_PROVIDER,
      providerResolved,
    };
  }

  peek(input) {
    // Both addressing styles must produce the identical composed key (asserted in the contract suite).
    if (typeof input === 'string') return this.entries.get(input);
    if (!input || typeof input !== 'object') return undefined;
    // A `binding` resolves to an entry key that ALREADY carries the provider prefix
    // (`<provider>\0<base>`, or `<provider>\0<base>:view:<id>` for a child tab), so composing the
    // provider again would double it and miss every bound runtime — that silently broke every
    // panel request addressed by runtime id (child tab /state + /frame, the tab `+` and the `×`).
    // Exact entry keys win; a bare workspace/scope key still goes through the provider composition.
    const exact = this.entries.get(String(input.key));
    if (exact) return exact;
    // A binding/recent request already carries a composed page-group key: composing it again would
    // manufacture a second root and silently miss the bound runtime.
    if (isPageGroupKey(input.key)) return undefined;
    const { provider } = this.providerFor(input);
    return this.entries.get(pageGroupKeyFor(provider, input.key, input.rootSessionId));
  }

  /**
   * Get (or lazily create) the page group of one (workspace, provider, **root**).
   *
   * The root dimension is what makes two independent sessions in one workspace stop sharing a
   * page: their keys can never collide, so neither can address, evict or write the other's target.
   * Creation is still cold (no page, no Chromium); it only binds an ownership record so the first
   * real operation has an owner to authorise against.
   */
  getOrCreate(resolved) {
    if (this.disposed) throw new BrowserError('SCOPE_UNAVAILABLE', '插件正在卸载');
    const { scope } = resolved;
    const baseKey = resolved.key;
    // A `recent` resolution hands back an ALREADY composed entry key (`<provider>\0<base>`), so
    // composing the provider again would manufacture a second runtime — with its own page — for a
    // workspace that already has one, on every `scope=recent` request (and it burns the global
    // page budget until `+` answers TAB_LIMIT for a workspace with two tabs). An exact key wins.
    const exact = this.entries.get(String(baseKey));
    if (exact) return exact;
    const { provider, providerResolved } = this.providerFor(resolved);
    const rootSessionId = String(resolved.rootSessionId || UNSCOPED_ROOT);
    // §6/§7.4: an entry is owned by (workspace, provider, root). `baseKey` stays the raw
    // workspace/scope identity (aggregate counting and config transitions address it that way);
    // the composed key carries all four dimensions and is never built by hand.
    const key = pageGroupKeyFor(provider, baseKey, rootSessionId);
    const existing = this.entries.get(key);
    if (existing) return existing;
    if (this.entries.size >= this.maxEntries) this.#evictColdEntry();
    const runtime = new Runtime(this.log, {
      host: this.browserHost(provider), origins: this.origins, scope, registry: this, viewerTtlMs: this.viewerTtlMs,
    });
    // Ownership is bound at first sight of the group, not at first page: an entry that exists but
    // has no owner could never be authorised, and "no owner yet" would have to mean "anyone".
    const creatorSessionId = String(resolved.creatorSessionId || resolved.sessionId || rootSessionId);
    const access = makePageAccess({ rootSessionId, creatorSessionId });
    const entry = { key, baseKey, provider, providerResolved, scope, runtime, kind: 'primary',
      viewId: 'primary', primaryKey: key, rootSessionId,
      ownership: access.ownership, control: access.control,
      parentRuntimeId: null, parentTabId: null, openEventId: null, createdBy: 'host',
      locked: false, tabId: 'primary', createdAt: Date.now(), lastUsedAt: Date.now() };
    this.entries.set(key, entry);
    this.providerByBaseKey.set(providerIndexKey(baseKey, rootSessionId), provider);
    return entry;
  }

  /**
   * Frozen M1 records of one physical page.
   *
   * Every entry (primary slot *and* child) carries its own ownership/control pair: a child page is
   * a separate page with a separate controller, and sharing the primary's records would let a
   * takeover of one silently authorise the other.
   */
  accessOf(entry) {
    const target = entry || {};
    return { ownership: target.ownership ?? null, control: target.control ?? null };
  }

  /** Replace an entry's records after a transition (M1 returns fresh frozen objects). */
  setAccess(entry, next) {
    if (!entry || !next) return;
    entry.ownership = next.ownership;
    entry.control = next.control;
  }

  /**
   * Authorise one effect against one page, throwing the mapped structured error on refusal.
   *
   * This is the only place index.js turns a permission verdict into an error, so every surface
   * reports the same code for the same reason (and the cross-root answer carries no details).
   */
  authorizePage(entry, principal, effect, operation = null, extra = {}) {
    const { ownership, control } = this.accessOf(entry);
    const verdict = authorize({ principal, ownership, control, effect, operation, ...extra });
    if (verdict.allowed) return verdict;
    throw this.accessError(verdict, operation);
  }

  accessError(verdict, operation) {
    if (verdict.notFound || verdict.reason === AUTHORIZE_REASON.CROSS_ROOT) {
      // Uniform, detail-free: a foreign root learns nothing about whether the page exists.
      return new BrowserError('TAB_NOT_FOUND', '标签不存在或不属于当前调用者', {
        hidden: true, operation: operation || null,
      });
    }
    const reason = verdict.reason;
    const message = reason === AUTHORIZE_REASON.ROLE_FORBIDDEN ? '当前会话无权操作该标签'
      : reason === AUTHORIZE_REASON.NOT_CONTROLLER ? '该标签当前由其他会话控制（读取最新状态后重新决策，不要自动重试）'
      : reason === AUTHORIZE_REASON.CONTROL_DRAINING ? '该标签正在被接管，旧版本写入已关闭'
      : reason === AUTHORIZE_REASON.TARGET_RETIRED ? '该标签已关闭或退休'
      : reason === AUTHORIZE_REASON.CONTROL_REVISION_STALE ? '标签控制版本已变化'
      : reason === AUTHORIZE_REASON.OWNERSHIP_REVISION_STALE ? '标签归属版本已变化'
      : reason === AUTHORIZE_REASON.IDENTITY_UNAVAILABLE ? '当前调用者身份无法证明'
      : reason === AUTHORIZE_REASON.HOST_MANAGE_FORBIDDEN ? '该操作只能由独立宿主管理通道执行'
      : '该操作不被允许';
    return new BrowserError(verdict.code || 'TAB_FORBIDDEN', message, {
      reason, effect: verdict.effect, resource: verdict.resource, operation: operation || null,
    });
  }

  /**
   * Read projection of one page's long-lived ownership/control (ruling §5: management replies carry
   * `changed` plus the final controller/versions, so callers never re-derive them from `busy`).
   */
  controlProjection(entry) {
    const { ownership, control } = this.accessOf(entry);
    return {
      accessVersion: 1,
      tabId: entry ? this.#tabId(entry) : null,
      rootSessionId: entry?.rootSessionId ?? null,
      creatorSessionId: ownership?.creatorSessionId ?? null,
      ownerSessionId: ownership?.ownerSessionId ?? null,
      ownershipRevision: ownership?.ownershipRevision ?? null,
      controllerSessionId: control?.controllerSessionId ?? null,
      controlRevision: control?.controlRevision ?? null,
      state: control?.state ?? null,
      pendingControllerSessionId: control?.pendingControllerSessionId ?? null,
    };
  }

  /**
   * Undo our own drain marker, leaving the record byte-identical (ruling §5.2 step 6).
   *
   * Only the actor that started the drain may cancel it, and only while the record is still the one
   * we drained (same state + same revision). Anything else is somebody else's move: the controller
   * must never "quietly" change because our request finished late, so we simply do not touch it.
   */
  cancelDrain(entry, principal, expectedControlRevision) {
    const { ownership, control } = this.accessOf(entry);
    if (!control || control.state !== CONTROL_STATE.DRAINING) return false;
    if (control.pendingControllerSessionId !== principal?.actorSessionId) return false;
    if (control.controlRevision !== expectedControlRevision) return false;
    try {
      const cancelled = applyControlTransition({ ownership, control }, {
        type: CONTROL_EVENT.ACQUIRE_CANCEL, principal, expectedControlRevision,
      });
      this.setAccess(entry, cancelled);
      return true;
    } catch {
      // The record moved on (closed/retired/transferred): never invent a state we cannot prove.
      return false;
    }
  }

  /**
   * Lead takeover: drain, wait for a safe boundary, then commit. Never abort in-flight work.
   *
   * Sequence (plan §5.2 / ruling §5.1):
   *   1. root → role → expected control version, all before anything moves (zero dispatch on refuse)
   *   2. mark draining: older writes now see a closed gate, while the controller is still the member
   *   3. wait (bounded, cancellable) until nothing is queued or running — `active`/`inflight` reach 0,
   *      which is host memory only: no CDP, no lease games, no interruption
   *   4. re-read the version, then commit controller=Lead with controlRevision+1 — or, on
   *      timeout/cancel/race, revoke the drain marker and report BUSY/ABORTED/CHANGED with the
   *      controller exactly where it was
   *
   * @returns {{changed:boolean, ownership:object, control:object, state:string, waitedMs:number}}
   */
  async acquireControl(entry, principal, {
    expectedControlRevision, timeoutMs = TAB_ACQUIRE_TIMEOUT_DEFAULT_MS, signal = undefined,
  } = {}) {
    this.authorizePage(entry, principal,
      { effect: EFFECT.MANAGE, resource: RESOURCE.PAGE, targetRequired: true },
      'browser_tabs.acquire', { expectedControlRevision });
    const runtime = entry.runtime;
    const startedAt = Date.now();
    const drained = applyControlTransition(this.accessOf(entry), {
      type: CONTROL_EVENT.ACQUIRE, principal, expectedControlRevision,
    });
    this.setAccess(entry, drained);
    if (!drained.changed) {
      return { changed: false, ownership: entry.ownership, control: entry.control, state: entry.control.state, waitedMs: 0 };
    }

    let outcome = 'settled';
    try {
      const deadline = startedAt + timeoutMs;
      for (;;) {
        if (runtime.active === 0 && runtime.inflight === 0) break;
        const remaining = deadline - Date.now();
        if (remaining <= 0) { outcome = 'timeout'; break; }
        await this.#waitNextPoll(Math.min(TAB_DRAIN_POLL_MS, remaining), signal);
      }
    } catch (error) {
      outcome = asBrowserError(error).code === 'ABORTED' ? 'aborted' : 'failed';
    }

    if (outcome === 'settled') {
      const current = this.accessOf(entry);
      const stillOurs = current.control
        && current.control.state === CONTROL_STATE.DRAINING
        && current.control.controlRevision === expectedControlRevision
        && current.control.pendingControllerSessionId === principal.actorSessionId;
      if (stillOurs) {
        const committed = applyControlTransition(current, {
          type: CONTROL_EVENT.ACQUIRE_COMMIT, principal, expectedControlRevision,
        });
        this.setAccess(entry, committed);
        // The drain proved there is no in-flight work, so the member's stale "recently wrote" lease
        // must not block the new controller's first write.
        this.clearForeignLease(entry, principal.actorSessionId);
        return {
          changed: committed.changed, ownership: entry.ownership, control: entry.control,
          state: entry.control.state, waitedMs: Date.now() - startedAt,
        };
      }
      outcome = 'raced';
    }

    this.cancelDrain(entry, principal, expectedControlRevision);
    const waitedMs = Date.now() - startedAt;
    if (outcome === 'aborted') {
      throw new BrowserError('ABORTED', '接管已取消：controller 与 controlRevision 均未改变', {
        reason: 'acquire-cancelled', controlRevision: entry.control?.controlRevision ?? null, waitedMs,
      });
    }
    if (outcome === 'raced') {
      throw new BrowserError('TAB_CONTROL_CHANGED', '接管期间控制版本已变化（draining 已撤销）', {
        reason: 'control-revision-stale', controlRevision: entry.control?.controlRevision ?? null, waitedMs,
      });
    }
    if (outcome === 'failed') {
      throw new BrowserError('TAB_CONTROL_CHANGED', '接管等待失败（draining 已撤销）', {
        reason: 'drain-failed', controlRevision: entry.control?.controlRevision ?? null, waitedMs,
      });
    }
    // BUSY, never "we finished it in the background": the drain marker is already gone.
    throw new BrowserError('BUSY', `接管在 ${timeoutMs}ms 内未等到安全边界，已撤销 draining，controller 未改变`, {
      reason: 'drain-timeout', timeoutMs, waitedMs, controlRevision: entry.control?.controlRevision ?? null,
    });
  }

  /**
   * A completed control transition voids the previous writer's short lease.
   *
   * The 15s lease only means "this session wrote recently"; it is not an ACL. Once control has moved
   * — and the drain certified there is no in-flight work — keeping the old lease would refuse the new
   * controller's very first write with BUSY, making the takeover useless for the 15s that follow.
   */
  clearForeignLease(entry, keepSessionId) {
    const runtime = entry?.runtime;
    if (!runtime || !runtime.lease) return false;
    if (runtime.lease.sessionId === keepSessionId) return false;
    runtime.release(runtime.lease.sessionId);
    return true;
  }

  /** Lead gives control back to the owner (controlRevision+1, ownership untouched). */
  releaseControl(entry, principal, { expectedControlRevision } = {}) {
    this.authorizePage(entry, principal,
      { effect: EFFECT.MANAGE, resource: RESOURCE.PAGE, targetRequired: true },
      'browser_tabs.release', { expectedControlRevision });
    const next = applyControlTransition(this.accessOf(entry), {
      type: CONTROL_EVENT.RELEASE, principal, expectedControlRevision,
    });
    this.setAccess(entry, next);
    this.clearForeignLease(entry, entry.ownership.ownerSessionId);
    return { changed: next.changed, ownership: entry.ownership, control: entry.control, state: entry.control.state };
  }

  /**
   * Lead transfers ownership+control to another valid member of this root.
   *
   * The roster is re-read from the native service **before** the metadata commit (ruling §2.2):
   * a cached membership list could already be stale, and handing a page to somebody who left the
   * team is exactly the kind of grant that must not survive on stale data.
   */
  transferControl(entry, principal, { toSessionId, expectedControlRevision, expectedOwnershipRevision } = {}) {
    this.authorizePage(entry, principal,
      { effect: EFFECT.MANAGE, resource: RESOURCE.PAGE, targetRequired: true },
      'browser_tabs.transfer', { expectedControlRevision, expectedOwnershipRevision });
    const row = this.assertTransferTarget(principal, toSessionId);
    const next = applyControlTransition(this.accessOf(entry), {
      type: CONTROL_EVENT.TRANSFER, principal, toSessionId: String(toSessionId).trim(),
      expectedControlRevision, expectedOwnershipRevision,
    });
    this.setAccess(entry, next);
    this.clearForeignLease(entry, String(toSessionId).trim());
    return {
      changed: next.changed, ownership: entry.ownership, control: entry.control,
      state: entry.control.state, to: row,
    };
  }

  /**
   * Validate a transfer target against the **fresh** native roster.
   *
   * A transfer is a grant, so "cannot prove membership" must never read as "allowed": without a
   * roster service the answer is TAB_IDENTITY_UNAVAILABLE, an unknown row is TAB_FORBIDDEN, and a
   * failed/provisioning row is TAB_FORBIDDEN too. Self-transfer is an argument error.
   */
  assertTransferTarget(principal, toSessionId) {
    const to = typeof toSessionId === 'string' ? toSessionId.trim() : '';
    if (!to || to.length > 128) {
      throw new BrowserError('INVALID_ARGUMENT', 'transfer.toSessionId 必须是 1–128 字符', { field: 'toSessionId' });
    }
    if (to === principal?.actorSessionId) {
      throw new BrowserError('INVALID_ARGUMENT', 'transfer 不能转交给自己', { field: 'toSessionId' });
    }
    // Native roster lookup is a Host service, injected by the composition root: the page registry
    // asks for it and never reaches into a Cordis context on its own.
    const service = typeof this.services === 'function' ? this.services : () => undefined;
    const teams = service('agentTeams');
    const agents = service('agents');
    if (!teams || typeof teams.listMembers !== 'function' || !agents || typeof agents.get !== 'function') {
      throw new BrowserError('TAB_IDENTITY_UNAVAILABLE', 'transfer 需要原生 roster 才能证明目标成员身份', {
        reason: 'transfer-needs-roster',
      });
    }
    const rootAgent = agents.get(principal.rootSessionId);
    if (!rootAgent) {
      throw new BrowserError('TAB_IDENTITY_UNAVAILABLE', 'root 未加载，无法核对 roster', {
        reason: 'root-not-loaded', rootSessionId: principal.rootSessionId,
      });
    }
    let rows;
    try {
      rows = teams.listMembers(rootAgent);
    } catch {
      throw new BrowserError('TAB_IDENTITY_UNAVAILABLE', 'roster 读取失败', { reason: 'roster-failed' });
    }
    if (!Array.isArray(rows)) {
      throw new BrowserError('TAB_IDENTITY_UNAVAILABLE', 'roster 形状异常', { reason: 'roster-malformed' });
    }
    const row = rows.find((candidate) => candidate && candidate.id === to);
    if (!row) {
      throw new BrowserError('TAB_FORBIDDEN', 'transfer 目标不是本 root 的成员', {
        reason: 'not-a-member', toSessionId: to,
      });
    }
    if (row.status === 'failed' || row.status === 'provisioning') {
      throw new BrowserError('TAB_FORBIDDEN', 'transfer 目标成员当前无有效身份', {
        reason: 'member-not-active', toSessionId: to, status: row.status,
      });
    }
    return { id: row.id, role: row.role ?? null, status: row.status ?? null };
  }

  findByRuntimeId(runtimeId) {
    if (typeof runtimeId !== 'string' || !runtimeId) return undefined;
    for (const entry of this.entries.values()) if (entry.runtime.runtimeId === runtimeId) return entry;
    return undefined;
  }

  entryForRuntime(runtime) {
    if (!runtime) return undefined;
    for (const entry of this.entries.values()) if (entry.runtime === runtime) return entry;
    return undefined;
  }

  primaryEntry(entry) {
    if (!entry) return undefined;
    const key = entry.primaryKey || entry.key;
    return this.entries.get(key) || (entry.kind === 'primary' ? entry : undefined);
  }

  /**
   * Child pages of one **(workspace, provider)** — deliberately *not* of one root.
   *
   * The product budget is "4 pages per workspace/provider" (1 primary + 3 children). Counting per
   * page-group key would turn that into "3 children per root", so two roots in one workspace could
   * hold 8 pages there and the per-workspace ceiling would be multiplied by the root count. The
   * global `maxPages` ceiling stays one number across every provider and root (a later quota slice
   * rewrites the full reservation algorithm; this is the minimal correction that keeps today's
   * numbers true).
   */
  popupCount(primaryEntry) {
    if (!primaryEntry) return 0;
    const workspaceKey = primaryEntry.baseKey;
    const provider = primaryEntry.provider ?? DEFAULT_RUNTIME_PROVIDER;
    let count = 0;
    for (const entry of this.entries.values()) {
      if (entry.kind !== 'popup') continue;
      if (entry.baseKey !== workspaceKey) continue;
      if ((entry.provider ?? DEFAULT_RUNTIME_PROVIDER) !== provider) continue;
      count += 1;
    }
    return count;
  }

  bumpViews(primaryKey) {
    if (!primaryKey) return;
    this.viewsRevision.set(primaryKey, (this.viewsRevision.get(primaryKey) || 0) + 1);
  }

  /** Reserve one popup slot without ever evicting a parent or another workspace. */
  reservePopupSlot(primaryEntry) {
    if (this.disposed) throw new BrowserError('SCOPE_UNAVAILABLE', '插件正在卸载');
    // A missing page group is a scope-resolution failure, never a tab-count limit: answering
    // TAB_LIMIT here made the panel tell a user with two tabs "最多 4 个标签".
    if (!primaryEntry) throw new BrowserError('SCOPE_NOT_FOUND', '找不到 popup 所属的 primary 工作区', { scope: 'binding' });
    if (this.popupCount(primaryEntry) >= this.maxPopupChildren) {
      throw new BrowserError('TAB_LIMIT', `每个工作区最多 ${this.maxPopupChildren} 个 popup 子页`, {
        dimension: 'workspace-provider',
        maxPopupChildren: this.maxPopupChildren, popupCount: this.popupCount(primaryEntry),
      });
    }
    const provider = primaryEntry.provider ?? DEFAULT_RUNTIME_PROVIDER;
    this.browserHost(provider);
    this.reservations += 1;
    // Cross-provider sum against the *same* ceiling: splitting hosts must not widen the budget.
    if (this.pageCount + this.reservations > this.maxPages) {
      this.reservations = Math.max(0, this.reservations - 1);
      throw new BrowserError('TAB_LIMIT', `popup 超出全局 ${this.maxPages} 页上限`, {
        maxPages: this.maxPages, pageCount: this.pageCount, reservations: this.reservations,
      });
    }
    let released = false;
    return () => {
      if (released) return;
      released = true;
      this.reservations = Math.max(0, this.reservations - 1);
    };
  }

  addPopupEntry({ parentEntry, runtime, viewId, openEventId, sourcePanelId, creatorSessionId = null }) {
    const primaryKey = parentEntry.primaryKey || parentEntry.key;
    // A child is its own target inside the same page group (ruling §7.4: PageTargetKey wraps the
    // group key, never a hand-built colon suffix on a composed key).
    const key = pageTargetKeyFor(primaryKey, viewId);
    const access = makePageAccess({
      rootSessionId: parentEntry.rootSessionId,
      creatorSessionId: creatorSessionId || parentEntry.rootSessionId,
    });
    const entry = {
      key, baseKey: parentEntry.baseKey ?? key, provider: parentEntry.provider ?? DEFAULT_RUNTIME_PROVIDER,
      providerResolved: parentEntry.providerResolved ?? 'recent',
      scope: parentEntry.scope, runtime, kind: 'popup', viewId, tabId: viewId,
      rootSessionId: parentEntry.rootSessionId,
      ownership: access.ownership, control: access.control,
      primaryKey, parentKey: parentEntry.key, parentRuntimeId: parentEntry.runtime.runtimeId,
      parentTabId: parentEntry.tabId || (parentEntry.kind === 'primary' ? 'primary' : parentEntry.viewId),
      openEventId: openEventId || null, sourcePanelId: sourcePanelId || null,
      createdBy: runtime.createdBy || 'gui',
      locked: false,
      status: 'initializing', createdAt: Date.now(), lastUsedAt: Date.now(),
    };
    this.entries.set(key, entry);
    this.bumpViews(primaryKey);
    return entry;
  }

  /** Close every popup child of one primary (parent close/plugin teardown). */
  async closeChildren(primaryEntry) {
    const children = [...this.entries.values()].filter((entry) => entry.kind === 'popup'
      && entry.primaryKey === (primaryEntry.primaryKey || primaryEntry.key));
    for (const entry of children) {
      try { await entry.runtime.close(); } catch { /* ignore */ }
    }
  }

  addPopupNotice(primaryEntry, { reason, openEventId = null } = {}) {
    if (!primaryEntry) return;
    const primaryKey = primaryEntry.primaryKey || primaryEntry.key;
    const list = this.popupNotices.get(primaryKey) || [];
    list.push({
      id: randomUUID(), reason: String(reason || 'blocked').slice(0, 64),
      parentTabId: primaryEntry.tabId || (primaryEntry.kind === 'primary' ? 'primary' : primaryEntry.viewId),
      parentRuntimeId: primaryEntry.runtime.runtimeId, openEventId: openEventId || null,
      at: Date.now(),
    });
    while (list.length > this.noticesLimit) list.shift();
    this.popupNotices.set(primaryKey, list);
    this.bumpViews(primaryKey);
  }

  /** Bounded read-only view of the blocked-popup notices for one workspace (TOOL-P0-01). */
  noticesView(primaryEntry) {
    if (!primaryEntry) return [];
    const list = this.popupNotices.get(primaryEntry.primaryKey || primaryEntry.key) || [];
    return list.map((notice) => ({ ...notice }));
  }

  /** Bounded read-only view of the close/idle/evict audit for one workspace (TOOL-P1-05). */
  recentClosedView(primaryEntry) {
    if (!primaryEntry) return [];
    const list = this.recentClosed.get(primaryEntry.primaryKey || primaryEntry.key) || [];
    return list.map((row) => ({ ...row }));
  }

  /** Append one close-audit row (tabId/kind/reason/at), capped at closedHistoryLimit. */
  #recordClosed(entry, reason) {
    const primaryKey = entry.primaryKey || entry.key;
    if (!primaryKey) return;
    const list = this.recentClosed.get(primaryKey) || [];
    const normalized = reason === 'idle' || reason === 'evicted' ? reason : 'closed';
    list.push({
      tabId: this.#tabId(entry), kind: this.#tabKind(entry), reason: normalized, at: Date.now(),
    });
    while (list.length > this.closedHistoryLimit) list.shift();
    this.recentClosed.set(primaryKey, list);
  }

  /** Same bounded workspace-group list for primary and every child /state. */
  uiViews(runtime) {
    const entry = this.entryForRuntime(runtime);
    const primary = this.primaryEntry(entry);
    if (!entry || !primary) return {};
    const primaryKey = primary.key;
    const children = [...this.entries.values()].filter((candidate) => candidate.kind === 'popup'
      && candidate.primaryKey === primaryKey);
    let changed = false;
    const views = [];
    for (const item of [primary, ...children]) {
      if (item.status === 'initializing') continue;
      const rt = item.runtime;
      const title = redactText(String(rt.title || '').replace(/[\u0000-\u001f\u007f]/gu, '')).slice(0, 120);
      let hostLabel = '';
      try { hostLabel = new URL(rt.url).hostname.slice(0, 120); } catch { /* empty */ }
      const status = rt.page && rt.cdp && !rt.cdp.closed ? 'ready' : 'closed';
      if (item.lastViewTitle !== title) { item.lastViewTitle = title; changed = true; }
      if (item.lastViewHost !== hostLabel) { item.lastViewHost = hostLabel; changed = true; }
      if (item.lastViewStatus !== status) { item.lastViewStatus = status; changed = true; }
      views.push({
        id: item.viewId, tabId: item.tabId || (item.kind === 'primary' ? 'primary' : item.viewId), runtimeId: rt.runtimeId, kind: item.kind,
        busy: Boolean(rt.lease && rt.hasLease()), owner: rt.lease && rt.hasLease() ? 'agent' : null,
        parentRuntimeId: item.kind === 'popup' ? item.parentRuntimeId : null,
        title, hostLabel, status, openEventId: item.openEventId || null,
        sourcePanelId: item.sourcePanelId || null,
        locked: Boolean(item.locked),
        createdBy: item.runtime.createdBy || (item.kind === 'popup' ? 'gui' : 'host'),
      });
    }
    if (changed) this.bumpViews(primaryKey);
    return {
      viewsVersion: 1,
      viewsRevision: this.viewsRevision.get(primaryKey) || 0,
      primaryRuntimeId: primary.runtime.runtimeId,
      views,
      popupNotices: [...(this.popupNotices.get(primaryKey) || [])],
    };
  }

  allocateRef() {
    if (this.nextGlobalRef >= Number.MAX_SAFE_INTEGER - 1) {
      throw new BrowserError('UNSUPPORTED', 'ref 编号已耗尽：请重启调试实例后再继续');
    }
    const value = 'e' + this.nextGlobalRef;
    this.nextGlobalRef += 1;
    return value;
  }

  tabEntries(primaryEntry) {
    const primaryKey = primaryEntry.primaryKey || primaryEntry.key;
    const primary = this.entries.get(primaryKey) || primaryEntry;
    const children = [...this.entries.values()].filter((entry) => entry.kind === 'popup' && entry.primaryKey === primaryKey);
    return [primary, ...children];
  }

  tabEntry(primaryEntry, tabId) {
    if (!primaryEntry) return undefined;
    const primaryKey = primaryEntry.primaryKey || primaryEntry.key;
    const primary = this.entries.get(primaryKey) || primaryEntry;
    if (!tabId || tabId === 'primary' || tabId === primary.tabId) return primary;
    return [...this.entries.values()].find((entry) => entry.kind === 'popup'
      && entry.primaryKey === primaryKey && (entry.tabId === tabId || entry.viewId === tabId));
  }

  /**
   * Selection identity: one row per (page group, actor). Both dimensions matter — a selection is
   * the *actor's* view of *their* group, so it can never be inherited across roots or actors.
   */
  #selectionKey(primaryEntry, sessionId) {
    return makeActorSelectionKey({
      groupKey: String(primaryEntry.key),
      actorSessionId: String(sessionId || 'anonymous'),
    });
  }

  /**
   * One actor's two selections inside one page group.
   *
   * `tabId` is the **work** selection and stays the compatibility projection (`selection` in every
   * response). `observationTabId` is the read-only selection: it is set only by an explicit
   * `select(mode:'observe')` and never by a write, so watching a teammate's page cannot redirect
   * either side's writes.
   */
  selectionFor(primaryEntry, sessionId) {
    const key = this.#selectionKey(primaryEntry, sessionId);
    const stored = this.selectedBySession.get(key);
    if (stored) return stored;
    const actor = String(sessionId || 'anonymous');
    return {
      // No record yet: default to the page this actor *already owns* in this group — its primary if
      // it owns the primary, otherwise a child it created — and to "no work page" when it owns
      // nothing. Defaulting a teammate to the Lead's primary turned "you have no page yet"
      // (TARGET_NOT_BOUND, "open one") into "you may not touch this page" (TAB_FORBIDDEN), which is
      // both the wrong code and a misleading story.
      tabId: this.#ownWorkTabId(primaryEntry, actor),
      observationTabId: null, revision: 0, resetReason: null, pendingReset: false,
      groupKey: String(primaryEntry.key), actorSessionId: actor,
      rootSessionId: primaryEntry.rootSessionId ?? rootOfPageGroupKey(primaryEntry.key),
      workspaceKey: primaryEntry.baseKey ?? null, provider: primaryEntry.provider ?? null,
    };
  }

  /**
   * The tab id this actor already owns in the group, or `null` when it owns none.
   *
   * Ownership — not the short lease and not "the group has a primary" — decides it: a teammate that
   * never opened a page must have no work selection at all rather than borrow somebody else's.
   */
  #ownWorkTabId(primaryEntry, actor) {
    if (!primaryEntry) return null;
    const primary = this.entries.get(primaryEntry.primaryKey || primaryEntry.key) || primaryEntry;
    if (primary?.ownership?.ownerSessionId === actor) return this.#tabId(primary);
    for (const entry of this.tabEntries(primaryEntry)) {
      if (entry.kind !== 'popup') continue;
      if (entry.ownership?.ownerSessionId === actor) return this.#tabId(entry);
    }
    return null;
  }

  /** Confirm a pending tab retirement (browser_tabs.current / explicit select). */
  confirmSelection(primaryEntry, sessionId) {
    const key = this.#selectionKey(primaryEntry, sessionId);
    const record = this.selectedBySession.get(key);
    if (!record) return this.selectionFor(primaryEntry, sessionId);
    const previous = record.resetReason || null;
    if (!record.pendingReset) return { ...record, confirmedResetReason: null };
    record.pendingReset = false;
    record.resetReason = null;
    // Back to the page this actor actually owns (their own primary, a child they created, or
    // nothing) — never blindly to "primary", which may belong to the Lead.
    record.tabId = this.#ownWorkTabId(primaryEntry, String(sessionId || 'anonymous'));
    record.observationTabId = null;
    delete record.resetTabId;
    record.revision += 1;
    this.selectedBySession.set(key, record);
    return { ...record, confirmedResetReason: previous };
  }

  /**
   * Resolve the page tool target for one Agent session.
   *
   * Reads use the observation selection when the caller set one, writes always use the work
   * selection (plan §5: "只读默认 observationSelection，未设再取 workSelection；写仅取 workSelection").
   * A pending retirement is a zero-dispatch error: the caller must confirm instead of being silently
   * re-pointed at another tab.
   */
  resolveSessionTab(primaryEntry, sessionId, { mode = 'work' } = {}) {
    const record = this.selectionFor(primaryEntry, sessionId);
    if (record.pendingReset) {
      throw new BrowserError('TARGET_NOT_FOUND', '选中的标签已关闭或退休，需用 browser_tabs.current 或 select 确认', {
        reason: record.resetReason || 'selected-tab-closed', tabId: record.tabId, fallbackTabId: 'primary',
      });
    }
    const tabId = mode === 'read' ? (record.observationTabId || record.tabId) : record.tabId;
    if (tabId === null || tabId === undefined) {
      // "You have no page of your own yet" is a binding answer, not a permission one (plan §6.1).
      throw new BrowserError('TARGET_NOT_BOUND', '当前会话还没有自己的工作页：先用 browser_tabs open 新建，或 select 自己拥有的标签', {
        reason: 'no-work-page', fallbackTabId: null, hint: 'browser_tabs.open', mode,
      });
    }
    if (tabId === 'primary') return { entry: this.entries.get(primaryEntry.key) || primaryEntry, selection: record };
    const entry = this.tabEntry(primaryEntry, tabId);
    if (!entry) {
      const key = this.#selectionKey(primaryEntry, sessionId);
      const next = {
        ...record, tabId: null, observationTabId: null, resetTabId: tabId,
        resetReason: 'tab-closed', pendingReset: true, revision: record.revision + 1,
      };
      this.selectedBySession.set(key, next);
      throw new BrowserError('TARGET_NOT_FOUND', '选中的标签已被关闭', {
        reason: 'selected-tab-closed', tabId, fallbackTabId: 'primary',
      });
    }
    return { entry, selection: record };
  }

  /**
   * Select a tab for one actor, in two independent modes (plan §5, ruling §7.5).
   *
   * `mode:'work'` needs the right to *write* that page (owner/controller, or this root's Lead);
   * `mode:'observe'` needs only the right to *read* it. Selecting never claims the short lease and
   * never activates the page: a selection is a routing preference, and the old "select claims, so
   * everyone else is BUSY" behaviour was the very thing that made two sessions fight over one tab.
   * A refused selection leaves the caller's existing selection untouched.
   */
  selectTab(primaryEntry, sessionId, tabId, { mode = 'work', principal = null } = {}) {
    if (!sessionId || sessionId === 'anonymous') {
      throw new BrowserError('UNSUPPORTED', 'browser_tabs 需要真实 Agent 会话身份', { reason: 'agent-session-required' });
    }
    const target = this.tabEntry(primaryEntry, tabId);
    if (!target) throw new BrowserError('TAB_NOT_FOUND', '标签不存在或不属于当前 workspace', { tabId, fallbackTabId: 'primary' });
    // `tabEntry` already filters by page group, so a foreign root's tabId cannot resolve here at
    // all; the ACL below is about role/control *inside* the group.
    if (principal) {
      if (mode === 'observe') {
        this.authorizePage(target, principal, { effect: EFFECT.OBSERVE, resource: RESOURCE.PAGE, targetRequired: true }, 'browser_tabs.select');
      } else {
        const verdict = authorize({
          principal, ...this.accessOf(target),
          effect: { effect: EFFECT.WRITE, resource: RESOURCE.PAGE, targetRequired: true },
          operation: 'browser_tabs.select',
        });
        // A Lead who may *manage* the page may also aim work at it (the takeover happens on the
        // first write, M4); a teammate who may not write it may not work-select it either.
        const manageable = verdict.allowed || authorize({
          principal, ...this.accessOf(target),
          effect: { effect: EFFECT.MANAGE, resource: RESOURCE.PAGE, targetRequired: true },
          operation: 'browser_tabs.acquire',
        }).allowed;
        if (!manageable) throw this.accessError(verdict, 'browser_tabs.select');
      }
    }
    const record = this.selectionFor(primaryEntry, sessionId);
    const next = {
      ...record,
      ...(mode === 'observe'
        ? { observationTabId: target.tabId || target.viewId || 'primary' }
        : { tabId: target.tabId || target.viewId || 'primary', pendingReset: false, resetReason: null }),
      revision: (record.revision || 0) + 1,
    };
    this.selectedBySession.set(this.#selectionKey(primaryEntry, sessionId), next);
    return { entry: target, selection: next };
  }

  #tabId(entry) {
    return entry.tabId || (entry.kind === 'primary' ? 'primary' : entry.viewId || 'primary');
  }

  #tabKind(entry) { return entry.kind === 'primary' ? 'primary' : 'tab'; }

  /**
   * Public source projection (TOOL-P0-01): primary slot / GUI-adopted or GUI+ child / explicit
   * Agent browser_tabs.open. `createdBy` stays an internal audit value.
   */
  #tabSource(entry) {
    if (entry.kind === 'primary') return 'primary';
    const createdBy = entry.createdBy || entry.runtime?.createdBy || 'gui';
    return createdBy === 'agent' ? 'agent-open' : 'gui-popup';
  }

  /** One list row. Read-only: no ensure, no queue, no lease, no CDP. */
  #tabView(entry, selection, sessionId, now = Date.now(), principal = null) {
    const runtime = entry.runtime;
    const owner = runtime.lease && runtime.hasLease() ? runtime.lease.sessionId : null;
    const tabId = this.#tabId(entry);
    const lastUsedAt = Number.isFinite(entry.lastUsedAt) ? entry.lastUsedAt : (Number.isFinite(entry.createdAt) ? entry.createdAt : null);
    return {
      tabId,
      runtimeId: runtime.runtimeId,
      kind: this.#tabKind(entry),
      title: redactText(String(runtime.title || '')).slice(0, 120),
      url: runtime.url ? redactUrl(runtime.url) : '',
      status: runtime.page && runtime.cdp && !runtime.cdp.closed ? 'ready' : 'closed',
      selected: selection.tabId === tabId,
      busy: Boolean(owner), owner: owner === sessionId ? 'self' : (owner ? 'other' : null),
      reset: selection.pendingReset && (selection.resetTabId || selection.tabId) === tabId
        ? selection.resetReason || null : null,
      // P0-E lifecycle projection: where the tab came from, who opened it and how long it lives.
      source: this.#tabSource(entry),
      parentTabId: entry.kind === 'popup' ? (entry.parentTabId || null) : null,
      openEventId: entry.openEventId || null,
      createdAt: Number.isFinite(entry.createdAt) ? entry.createdAt : null,
      lastUsedAt,
      // Human keep-alive lock (panel-only). `idleRemainingMs` stays the real clock: a locked row
      // reports null remaining because the sweep no longer applies to it.
      locked: Boolean(entry.locked),
      idleMs: Number.isFinite(this.idleMs) ? this.idleMs : null,
      idleRemainingMs: entry.locked ? null : Number.isFinite(this.idleMs) && Number.isFinite(lastUsedAt)
        ? Math.max(0, this.idleMs - Math.max(0, now - lastUsedAt)) : null,
      // `manageable` = this Agent session may act on the tab now (not another session's lease).
      // Kept ONLY as the legacy short-lease projection (ruling §5): it never expressed an ACL, and
      // new callers must read `permissions` instead.
      manageable: owner === null || owner === sessionId,
      // Long-lived ownership/control projection (ruling §5 "每页返回", all of it root-scoped: the
      // rows only ever describe pages inside the caller's own page group).
      accessVersion: 1,
      rootSessionId: entry.rootSessionId ?? null,
      creatorSessionId: entry.ownership?.creatorSessionId ?? null,
      ownerSessionId: entry.ownership?.ownerSessionId ?? null,
      controllerSessionId: entry.control?.controllerSessionId ?? null,
      ownershipRevision: entry.ownership?.ownershipRevision ?? null,
      controlRevision: entry.control?.controlRevision ?? null,
      accessState: entry.control?.state ?? null,
      permissions: principal ? projectPermissions({ principal, ...this.accessOf(entry) }) : null,
    };
  }

  listTabs(primaryEntry, sessionId, principal = null) {
    const selection = this.selectionFor(primaryEntry, sessionId);
    const now = Date.now();
    return this.tabEntries(primaryEntry)
      .map((entry) => this.#tabView(entry, selection, sessionId, now, principal));
  }

  /**
   * browser_tabs.wait: pure Host-memory polling (TOOL-P0-01).
   *
   * Without `tabId`, only tabs that were not already present when the call started can match, so
   * an immediate `list` that already shows a child can never be mistaken for "a new tab appeared".
   * With `tabId`, waits for that exact id (immediately when it already exists). `initializing`
   * popups only match once they are no longer initializing, i.e. when they appear in ui.views.
   * Never starts Chromium, never takes/extends a lease and never advances an idle timer.
   * Returns `{matched:true, matchedTab, elapsedMs, polls, condition}` — `matchedTab` is the tab row,
   * because the tool envelope always owns the standard `tab:{id,runtimeId,selectionRevision}` field.
   */
  async waitForTab(primaryEntry, sessionId, { tabId = null, kind = null, source = null,
    timeoutMs = TAB_WAIT_TIMEOUT_DEFAULT_MS, pollMs = TAB_WAIT_POLL_DEFAULT_MS } = {}, signal) {
    const startedAt = Date.now();
    const baseline = new Set(this.tabEntries(primaryEntry)
      .filter((entry) => entry.status !== 'initializing')
      .map((entry) => this.#tabId(entry)));
    const condition = { tabId: tabId || null, kind: kind || null, source: source || null, timeoutMs, pollMs };
    let polls = 0;
    for (;;) {
      if (signal && signal.aborted) throw new BrowserError('ABORTED', '等待标签被取消', { reason: 'aborted' });
      polls += 1;
      const tab = this.#findAppearingTab(primaryEntry, sessionId, { tabId, kind, source }, baseline);
      if (tab) return { matched: true, matchedTab: tab, elapsedMs: Date.now() - startedAt, polls, condition };
      const elapsed = Date.now() - startedAt;
      if (elapsed >= timeoutMs) {
        throw new BrowserError('WAIT_TIMEOUT', `等待标签在 ${timeoutMs}ms 预算内未出现（${polls} 次采样）`, {
          matched: false, elapsedMs: elapsed, polls, condition,
          lastTabIds: this.tabEntries(primaryEntry).map((entry) => this.#tabId(entry)),
        });
      }
      await this.#waitNextPoll(Math.min(pollMs, Math.max(1, timeoutMs - elapsed)), signal);
    }
  }

  #findAppearingTab(primaryEntry, sessionId, { tabId, kind, source }, baseline) {
    const selection = this.selectionFor(primaryEntry, sessionId);
    const now = Date.now();
    for (const entry of this.tabEntries(primaryEntry)) {
      const id = this.#tabId(entry);
      if (tabId) {
        if (id !== tabId) continue;
      } else if (baseline.has(id)) {
        continue;
      }
      if (entry.status === 'initializing') continue;
      if (kind && this.#tabKind(entry) !== kind) continue;
      if (source && this.#tabSource(entry) !== source) continue;
      return this.#tabView(entry, selection, sessionId, now);
    }
    return null;
  }

  #waitNextPoll(ms, signal) {
    return new Promise((resolve, reject) => {
      let timer;
      const cleanup = () => {
        if (timer) clearTimeout(timer);
        if (signal) signal.removeEventListener('abort', onAbort);
      };
      const onAbort = () => {
        cleanup();
        reject(new BrowserError('ABORTED', '等待标签被取消', { reason: 'aborted' }));
      };
      if (signal && signal.aborted) {
        cleanup();
        reject(new BrowserError('ABORTED', '等待标签被取消', { reason: 'aborted' }));
        return;
      }
      timer = setTimeout(() => { cleanup(); resolve(); }, ms);
      if (signal) signal.addEventListener('abort', onAbort, { once: true });
    });
  }

  /** P0-E explicit open: create about:blank child and select it for this session. */
  async openTab(primaryEntry, sessionId, source = 'agent', { select = true, principal = null } = {}) {
    if (!sessionId || sessionId === 'anonymous') {
      throw new BrowserError('UNSUPPORTED', 'browser_tabs 需要真实 Agent 会话身份', { reason: 'agent-session-required' });
    }
    // Creation authorisation runs *before* the reservation and before any CDP: a caller that may
    // not create pages in this group must not even reach `createTarget`.
    if (principal) {
      this.authorizePage(primaryEntry, principal,
        { effect: EFFECT.WRITE, resource: RESOURCE.PAGE, targetRequired: false }, 'browser_tabs.open');
    }
    const release = this.reservePopupSlot(primaryEntry);
    const viewId = randomUUID().replace(/-/gu, '').slice(0, 20);
    const primary = this.entries.get(primaryEntry.primaryKey || primaryEntry.key) || primaryEntry;
    const child = new Runtime(this.log, {
      host: this.browserHost(), origins: this.origins, scope: primary.scope, registry: this,
      kind: 'popup', parentRuntimeId: primary.runtime.runtimeId, viewId, parentKey: primary.key,
      openEventId: null, sourcePanelId: null, createdBy: source, inheritView: primary.runtime.view,
    });
    // Who owns a page the *panel* opened? The session the panel is showing, not the panel's own
    // synthetic actor: the panel is a view of that session's domain, and a tab opened from it must
    // stay drivable by that session. A tool-driven open is owned by the calling actor.
    const creatorSessionId = principal ? sessionId : (primary.ownership?.ownerSessionId || sessionId);
    const entry = this.addPopupEntry({
      parentEntry: primary, runtime: child, viewId, openEventId: null, sourcePanelId: null,
      creatorSessionId,
    });
    entry.status = 'initializing';
    try {
      const page = await this.browserHost().createPage(child, AbortSignal.timeout(10000));
      await child.adoptPage(page, { signal: AbortSignal.timeout(10000) });
      entry.status = 'ready';
      this.bumpViews(entry.primaryKey);
      // `open` sets both selections for its own actor (plan §5): the caller asked for this page
      // as its work target *and* as the thing it is looking at.
      const selected = select
        ? this.selectTab(primary, sessionId, viewId, { mode: 'work', principal })
        : { selection: this.selectionFor(primary, sessionId) };
      if (select) {
        const record = this.selectionFor(primary, sessionId);
        this.selectedBySession.set(this.#selectionKey(primary, sessionId), { ...record, observationTabId: viewId });
      }
      return { entry, selection: selected.selection };
    } catch (error) {
      try { await child.close(); } catch { /* ignore */ }
      try { this.onRuntimeClosed(child); } catch { /* ignore */ }
      throw error;
    } finally {
      release();
    }
  }

  /**
   * Close one tab. Primary only goes cold; children are destroyed.
   *
   * Agent close is now authorised by *ownership/control* (M1 `authorize`), not by holding the 15s
   * lease: the lease says "someone is busy right now", which is a scheduling fact, not a permission.
   * A teammate closing a teammate's page is refused here; a foreign root never resolves the tab at
   * all. The GUI path (`gui:true`) keeps its historical shape — it has no Principal until M5, which
   * is reported as a known gap rather than papered over with a fake one.
   */
  async closeTab(primaryEntry, sessionId, tabId, { gui = false, principal = null } = {}) {
    const wanted = tabId || this.selectionFor(primaryEntry, sessionId).tabId;
    if (!wanted) {
      // Same rule as a page tool: nothing selected means "no page yet", never "the primary".
      throw new BrowserError('TARGET_NOT_BOUND', '当前会话没有可关闭的页：省略 tabId 时需要先 open/select', {
        reason: 'no-work-page', hint: 'browser_tabs.open',
      });
    }
    const target = this.tabEntry(primaryEntry, wanted);
    if (!target) throw new BrowserError('TAB_NOT_FOUND', '标签不存在或不属于当前 workspace', { tabId });
    if (!gui) {
      if (principal) {
        this.authorizePage(target, principal,
          { effect: EFFECT.MANAGE, resource: RESOURCE.PAGE, targetRequired: true }, 'browser_tabs.close');
      } else {
        // Legacy/GUI callers without a Principal keep the old short-lease rule (M5 will replace it
        // with a verified panel seat; until then this must not silently become "anyone may close").
        const owner = target.runtime.lease && target.runtime.hasLease() ? target.runtime.lease.sessionId : null;
        if (owner !== sessionId) throw new BrowserError('TAB_FORBIDDEN', '关闭标签需要当前会话持有该标签的 lease', { tabId, owner });
      }
    }
    if (gui && target.runtime.hasLease()) throw new BrowserError('BUSY', '标签正由 Agent 操作，GUI 暂不能关闭', { tabId });
    if (target.runtime.active > 0 || target.runtime.inflight > 0) {
      throw new BrowserError('BUSY', '标签正在执行操作，暂不能关闭', { tabId });
    }
    // Primary close only makes primary cold; children stay live (P0-E §1).
    target.closeReason = 'closed';
    // Lifecycle versioning (ruling §7.1): a close always advances controlRevision, so a management
    // CAS that was in flight against the old page can never land on the reopened one. A child page
    // is retired outright; a primary slot keeps its history and stays `owned` because it will be
    // reopened in place (M4 adds the explicit acquire/release/transfer transitions).
    if (target.ownership && target.control) {
      target.control = makeControl({
        state: target.kind === 'popup' ? CONTROL_STATE.RETIRED : CONTROL_STATE.OWNED,
        controllerSessionId: target.kind === 'popup' ? null : target.ownership.ownerSessionId,
        controlRevision: target.control.controlRevision + 1,
      });
    }
    await target.runtime.run(() => target.runtime.close(), { sessionId, agent: false });
    return { closed: target.tabId || (target.kind === 'primary' ? 'primary' : target.viewId) };
  }

  /** Runtime close hook: popup entries retire; the primary stays as a cold entry. */
  onRuntimeClosed(runtime) {
    const entry = this.entryForRuntime(runtime);
    if (!entry) return;
    // Lifecycle audit (TOOL-P1-05): explicit close/sweep/evict set entry.closeReason before the
    // runtime is torn down; an external targetDestroyed/window.close keeps the default 'closed'.
    // Failed opens (initializing entries with no explicit reason) are not tabs the caller saw.
    const closeReason = entry.closeReason || 'closed';
    if (entry.closeReason !== 'failed' && !(entry.status === 'initializing' && !entry.closeReason)) {
      try { this.#recordClosed(entry, closeReason); } catch { /* audit only */ }
    }
    if (entry.kind === 'popup') {
      const tabId = entry.tabId || entry.viewId;
      for (const [key, record] of this.selectedBySession) {
        // Only selections *inside this page group* may be reset: a same-named tabId in another
        // root's group is a different page and must not be disturbed.
        if (!record || record.groupKey !== entry.primaryKey) continue;
        const touchesWork = record.tabId === tabId;
        const touchesObserve = record.observationTabId === tabId;
        if (!touchesWork && !touchesObserve) continue;
        this.selectedBySession.set(key, {
          ...record,
          // The retired tab must not be replaced by "primary": for a teammate the primary belongs to
          // the Lead, and pointing there would turn the confirm flow into "you may not touch this
          // page". The work selection becomes *unbound* and `resetTabId` keeps the audit of what
          // retired (the panel still shows which tab was reset).
          ...(touchesWork ? { tabId: null, resetTabId: tabId, resetReason: 'tab-closed', pendingReset: true } : {}),
          ...(touchesObserve ? { observationTabId: null } : {}),
          revision: record.revision + 1,
        });
      }
      this.entries.delete(entry.key);
      this.bumpViews(entry.primaryKey);
    } else {
      this.bumpViews(entry.key);
    }
  }

  /**
   * Last real interaction, per root when a root is named.
   *
   * A root-scoped caller only ever sees its own root's entry. A **rootless** caller (the legacy
   * panel protocol, which carries no session identity at all) keeps the historical single
   * "most recently used page" pointer: that is a navigation convenience, not an authorisation —
   * every page operation re-authorises against the caller's own identity, and M5 replaces the
   * unbound panel with a verified seat. Answering `undefined` there would break the panel without
   * making anything safer.
   */
  recentEntry(rootSessionId) {
    if (rootSessionId !== undefined && rootSessionId !== null && rootSessionId !== '') {
      const root = String(rootSessionId);
      const key = this.recentByRoot.get(root);
      if (!key) return undefined;
      const entry = this.entries.get(key);
      if (!entry) this.recentByRoot.delete(root);
      return entry;
    }
    let best;
    for (const entry of this.entries.values()) {
      if (entry.kind === 'popup') continue;
      if (entry.baseKey === LEGACY_SCOPE.key) continue;
      if (!best || (entry.lastUsedAt || 0) > (best.lastUsedAt || 0)) best = entry;
    }
    return best;
  }

  markRecent(entry) {
    if (!entry || entry.baseKey === LEGACY_SCOPE.key) return;
    // A popup child never becomes the Agent's recent/primary target.
    if (entry.kind === 'popup') return;
    this.recentByRoot.set(String(entry.rootSessionId || UNSCOPED_ROOT), entry.key);
  }

  touch(entry) { if (entry) entry.lastUsedAt = Date.now(); }

  /**
   * Human keep-alive lock: the only write surface is the panel route, never an Agent tool.
   * `locked` is Host memory (an entry, not a runtime), so a reopened primary keeps the lock only
   * as long as this entry object lives. Locking is idempotent; unlocking restarts the idle window
   * from "now" so a page unlocked after a long lock is not immediately swept.
   */
  setTabLock(primaryEntry, tabId, locked) {
    const target = this.tabEntry(primaryEntry, tabId);
    if (!target) throw new BrowserError('TAB_NOT_FOUND', '标签不存在或不属于当前 workspace', { tabId });
    const next = Boolean(locked);
    const changed = Boolean(target.locked) !== next;
    target.locked = next;
    if (changed) {
      // A lock/unlock is a lifecycle change the panel renders, so the group view must republish;
      // unlocking also restarts the idle window (see the note above).
      if (!next) target.lastUsedAt = Date.now();
      // The lock does not own the page queue or the lease: nothing in flight is disturbed.
      try { this.bumpViews(target.primaryKey || target.key); } catch { /* projection only */ }
    }
    return { tabId: target.tabId || (target.kind === 'primary' ? 'primary' : target.viewId), locked: next, changed };
  }

  /** Read-only projection of one entry's lock (list rows report it; no page, no lease, no CDP). */
  isLocked(entry) { return Boolean(entry && entry.locked); }

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
        victim.closeReason = 'evicted';
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
      // A human-locked tab is never a capacity victim: making room must cost an idle page, never
      // the one the user pinned. RUNTIME_LIMIT is the honest answer when nothing else is free.
      if (entry.locked) continue;
      if (!runtime.page) continue;
      if (!runtime.evictable()) continue;
      if (!best || entry.lastUsedAt < best.lastUsedAt) best = entry;
    }
    return best;
  }

  #evictColdEntry() {
    let best;
    for (const entry of this.entries.values()) {
      // Same rule for cold entries: a locked slot keeps its entry (and its runtimeId binding).
      if (entry.locked) continue;
      if (entry.runtime.page) continue;
      if (!best || entry.lastUsedAt < best.lastUsedAt) best = entry;
    }
    if (!best) throw new BrowserError('RUNTIME_LIMIT', 'scope 实例数量达到上限，且没有可回收的空闲实例', { maxEntries: this.maxEntries });
    best.closeReason = 'evicted';
    this.#retire(best);
  }

  #retire(entry) {
    // Cold-entry retirement is a lifecycle event too (TOOL-P1-05): default to evicted, while the
    // idle sweep marks its entries 'idle' before calling here.
    try {
      if (entry.closeReason !== 'failed') this.#recordClosed(entry, entry.closeReason || 'evicted');
    } catch { /* audit only */ }
    this.entries.delete(entry.key);
    if (entry.kind === 'popup' && entry.primaryKey) this.bumpViews(entry.primaryKey);
    else if (entry.kind === 'primary') this.pruneSelections();
    for (const [root, key] of [...this.recentByRoot]) if (key === entry.key) this.recentByRoot.delete(root);
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
        if (entry.baseKey === LEGACY_SCOPE.key) continue; // old client compatibility: keep the entry
        const runtime = entry.runtime;
        const idleFor = now - entry.lastUsedAt;
        if (idleFor < this.idleMs) continue;
        // Human keep-alive lock: a pinned tab is exempt from the idle sweep until it is unlocked
        // (or closed). It keeps its idle clock reading, so the untouched page still reports the
        // real elapsed idle time to the panel.
        if (entry.locked) continue;
        if (runtime.page) {
          if (!runtime.evictable()) continue;
          // Restart the idle window before the (possibly slow) close: a concurrent/next sweep
          // must not retire the cold entry while the host is still shutting down.
          entry.closeReason = 'idle';
          entry.lastUsedAt = Date.now();
          try { await runtime.close(); } catch { /* ignore */ }
          entry.lastUsedAt = Date.now();
        } else {
          // A cold entry may still have an ensure/operation in flight (e.g. the shared host is
          // restarting); retiring it here would orphan the page the operation is creating.
          if (runtime.inflight > 0 || runtime.starting || runtime.closing || runtime.hasLease() || runtime.viewers > 0) continue;
          entry.closeReason = 'idle';
          this.#retire(entry);
        }
      }
    } finally {
      this.sweeping = false;
    }
  }

  /** The shared host exits only when the last page is gone and no create is in flight. */
  async maybeCloseHost(provider = null) {
    if (this.disposed) return;
    if (this.reservations > 0) return;
    const candidates = provider === null
      ? [...this.hosts.values()]
      : [this.hosts.get(provider)].filter(Boolean);
    let closing;
    for (const host of candidates) {
      if (host.pageCount > 0 || host.pendingCreates > 0 || host.starting) continue;
      if (host.closing) { closing = closing ?? host.closing; continue; }
      if (!host.proc && !host.profileDir && !host.browserCdp) continue;
      closing = closing ?? host.close();
    }
    return closing;
  }

  releaseSession(sessionId) {
    for (const entry of this.entries.values()) entry.runtime.release(sessionId);
    // Selections are deliberately NOT dropped here any more.
    //
    // A real host emits `agent/disposed` at almost every turn boundary, so deleting the record there
    // reset the selection revision to 0 and silently discarded `pendingReset`: the caller was never
    // told "your tab was retired, confirm with current", it just got a fresh default that pointed at
    // the Lead's primary. A selection is (page group, actor) state — it outlives an execution
    // instance and is pruned when its page group disappears (see `pruneSelections`).
    this.pruneSelections();
  }

  /** Drop selection rows whose page group is gone (bounded by the live entry table). */
  pruneSelections() {
    if (this.selectedBySession.size === 0) return 0;
    const liveGroups = new Set();
    for (const entry of this.entries.values()) {
      if (entry.kind === 'primary') liveGroups.add(entry.key);
      if (entry.primaryKey) liveGroups.add(entry.primaryKey);
    }
    let dropped = 0;
    for (const [key, record] of [...this.selectedBySession]) {
      const groupKey = record && record.groupKey;
      if (!groupKey || !liveGroups.has(groupKey)) {
        this.selectedBySession.delete(key);
        dropped += 1;
      }
    }
    return dropped;
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
    this.recentByRoot.clear();
    for (const runtime of runtimes) {
      try { await runtime.close(); } catch { /* ignore */ }
      try { this.onRetire?.(runtime); } catch { /* ignore */ }
      try { runtime.frameTransport?.dispose?.(); } catch { /* ignore */ }
      try { runtime.disposeVision?.(); } catch { /* ignore */ }
      try { await runtime.disposeDynamic?.(); } catch { /* ignore */ }
    }
    for (const host of this.hosts.values()) {
      try { await host.close(); } catch { /* one provider's failure must not mask the others */ }
    }
    this.hosts.clear();
    this.providerByBaseKey.clear();
  }

  /**
   * Close one provider only (§6): its entries and its host. Another provider's pages, leases and
   * refs are untouched, so closing Chrome never kills an Agent's Edge session.
   */
  async closeProvider(provider) {
    const id = typeof provider === 'string' && provider.length > 0 ? provider : DEFAULT_RUNTIME_PROVIDER;
    const doomed = [...this.entries.values()].filter((entry) => (entry.provider ?? DEFAULT_RUNTIME_PROVIDER) === id);
    for (const entry of doomed) {
      try { await entry.runtime.close(); } catch { /* ignore */ }
      try { this.onRetire?.(entry.runtime); } catch { /* ignore */ }
      this.entries.delete(entry.key);
      for (const [root, key] of [...this.recentByRoot]) if (key === entry.key) this.recentByRoot.delete(root);
    }
    for (const [baseKey, owner] of [...this.providerByBaseKey]) {
      if (owner === id) this.providerByBaseKey.delete(baseKey);
    }
    const host = this.hosts.get(id);
    this.hosts.delete(id);
    if (host) { try { await host.close(); } catch { /* ignore */ } }
    return { provider: id, closedEntries: doomed.length };
  }
}

export function waitForExit(proc, timeoutMs) {
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

export const HTTP_METHODS = Object.freeze(['GET', 'HEAD', 'POST', 'PUT', 'PATCH', 'DELETE', 'OPTIONS']);

export const HTTP_DEFAULTS = Object.freeze({ method: 'GET', timeoutMs: 5000, maxBytes: 65536, followRedirects: false, maxRedirects: 0 });

export const HTTP_LIMITS = Object.freeze({
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

export const HTTP_ARG_KEYS = Object.freeze(['method', 'url', 'headers', 'body', 'timeoutMs', 'maxBytes', 'followRedirects', 'maxRedirects']);
/** Never forwarded from the caller: Node generates protocol headers itself; cookie is banned. */

/** Never forwarded from the caller: Node generates protocol headers itself; cookie is banned. */
export const HTTP_DANGEROUS_HEADERS = new Set([
  'host', 'content-length', 'transfer-encoding', 'connection', 'proxy-connection', 'keep-alive',
  'te', 'trailer', 'upgrade', 'expect', 'cookie', 'cookie2', 'proxy-authorization',
  'proxy-authenticate', 'accept-encoding',
]);

export const HTTP_SENSITIVE_HEADER_NAME = /token|key|secret|password|auth|code|session/iu;
/** Always masked entirely, regardless of the generic name pattern. */

/** Always masked entirely, regardless of the generic name pattern. */
export const HTTP_SENSITIVE_HEADERS = new Set([
  'set-cookie', 'set-cookie2', 'cookie', 'cookie2', 'authorization', 'proxy-authorization',
  'www-authenticate', 'proxy-authenticate', 'authentication-info', 'proxy-authentication-info', 'x-api-key',
]);

export const HTTP_URL_HEADER_NAMES = new Set(['location', 'content-location']);

export const HTTP_REDIRECT_STATUS = new Set([301, 302, 303, 307, 308]);

export function isPlainRecord(value) {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return false;
  const prototype = Object.getPrototypeOf(value);
  return prototype === null || prototype === Object.prototype;
}

export function invalidHttp(message, details = {}) {
  return new BrowserError('INVALID_ARGUMENT', message, { operation: 'http-request', phase: 'validation', ...details });
}

export function httpError(code, message, details = {}) {
  return new BrowserError(code, message, { operation: 'http-request', ...details });
}

export function integerInRange(value, fallback, min, max, name) {
  if (value === undefined) return fallback;
  if (typeof value !== 'number' || !Number.isInteger(value) || Object.is(value, -0) || value < min || value > max) {
    throw invalidHttp(`${name} 必须是 ${min}–${max} 的整数`);
  }
  return value;
}

export function booleanField(value, fallback, name) {
  if (value === undefined) return fallback;
  if (typeof value !== 'boolean') throw invalidHttp(`${name} 必须是布尔值`);
  return value;
}

/** Validate caller headers and normalize names to lower case (case-insensitive duplicates rejected). */

/** Validate caller headers and normalize names to lower case (case-insensitive duplicates rejected). */
export function validateHttpHeaders(value) {
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

export function validateHttpBody(value, method) {
  if (value === undefined) return undefined;
  if (typeof value !== 'string') throw invalidHttp('body 只能是 UTF-8 字符串（自行 JSON.stringify，不自动设置 content-type）');
  if (method === 'GET' || method === 'HEAD') throw invalidHttp(`${method} 请求不能提供 body（包括空字符串）`);
  if (Buffer.byteLength(value, 'utf8') > HTTP_LIMITS.bodyBytes) throw invalidHttp(`body 超过 ${HTTP_LIMITS.bodyBytes} UTF-8 字节`);
  return value;
}

/** Whole-batch validation: nothing is dispatched (and Chromium is not touched) before this passes. */

/** Whole-batch validation: nothing is dispatched (and Chromium is not touched) before this passes. */
export function validateHttpRequest(args) {
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

/** Raw (unredacted) header record used for protocol decisions only. */
export function rawHeaderMap(rawHeaders) {
  const map = new Map();
  for (let index = 0; index + 1 < rawHeaders.length; index += 2) {
    const name = String(rawHeaders[index]).toLowerCase();
    if (!map.has(name)) map.set(name, []);
    map.get(name).push(String(rawHeaders[index + 1]));
  }
  return map;
}

export function rawHeaderBytes(rawHeaders) {
  let total = 0;
  for (let index = 0; index + 1 < rawHeaders.length; index += 2) {
    total += Buffer.byteLength(String(rawHeaders[index]), 'utf8') + Buffer.byteLength(String(rawHeaders[index + 1]), 'utf8') + 4;
  }
  return total;
}

export function resolveHeaderUrl(value, baseUrl) {
  try { return new URL(value, baseUrl).href; } catch { return value; }
}

/** Lower-case name → non-empty string[] (duplicates preserved), sensitive values masked. */

/** Lower-case name → non-empty string[] (duplicates preserved), sensitive values masked. */
export function projectResponseHeaders(rawHeaders, baseUrl) {
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

export function isTextualContentType(contentType) {
  if (!contentType) return false;
  const type = String(contentType).split(';')[0].trim().toLowerCase();
  if (type.startsWith('text/')) return true;
  return ['application/json', 'application/xml', 'application/javascript', 'application/x-www-form-urlencoded'].includes(type)
    || /^application\/[^;]+\+json$/u.test(type) || /^application\/[^;]+\+xml$/u.test(type);
}

export function charsetAllowsUtf8(contentType) {
  const match = /charset\s*=\s*"?([^";\s]+)"?/iu.exec(String(contentType || ''));
  if (!match) return true;
  const charset = match[1].toLowerCase();
  return charset === 'utf-8' || charset === 'utf8' || charset === 'us-ascii';
}

/** utf8 only for uncompressed textual bodies with a utf-8-compatible charset and strict decode. */

/** utf8 only for uncompressed textual bodies with a utf-8-compatible charset and strict decode. */
export function encodeHttpBody(buffer, rawMap, contentType) {
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

/** 303 (except HEAD) → GET; 301/302 only POST → GET; 307/308 keep method and body. */
export function redirectMethod(status, method) {
  if (status === 303) return method === 'HEAD' ? 'HEAD' : 'GET';
  if (status === 301 || status === 302) return method === 'POST' ? 'GET' : method;
  return method;
}

export function roundMs(value) {
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

/* ---------------------------------------------------------------------------------------------
 * Read-only element pick for the debug view ("选元素加入聊天框"): POST /plugins/ui-testing/element.
 *
 * The panel sends page *document* CSS pixels: the space of `getBoundingClientRect()` plus
 * `scrollX/scrollY`, which is the canvas coordinate space when the canvas offset O = 0
 * (docs/viewport-control.md §混合画布). The reply is the hit element plus its document rect, the
 * `scroll` the rect was computed with (same Page.getLayoutMetrics read) and the main-frame
 * `loaderId` (document generation, so the panel can discard a response that raced a navigation).
 * `detail:true` adds a robust CSS selector, the whitespace-collapsed outerHTML/text, the
 * best-effort accessibility role/name and — for a hit inside a shadow root — the root-scoped
 * selector facts (`shadowHost`, `closedShadow`).
 *
 * Coordinate space, measured on this Chromium by tests/acceptance/pick-element-host.mjs (H0):
 *   - `DOM.getNodeForLocation` takes MAIN-FRAME DOCUMENT coordinates (scroll included) and only
 *     hits the CURRENTLY VISIBLE area (`y = scrollY` hits, `y = scrollY - 1` / `y = scrollY +
 *     clientHeight` answer "No node found at given location"); fractional input is rejected, so
 *     the route floors it;
 *   - `DOM.getBoxModel` returns ROOT-FRAME VIEWPORT quads (even for a `position:fixed` element),
 *     so the document rect is the border quad translated by
 *     `Page.getLayoutMetrics.cssLayoutViewport.pageX/pageY`.
 *
 * Scope: v1 picks inside the MAIN frame only — the same "frame: main" DOM tree T2 snapshots use.
 * A cross-frame hit (e.g. a point over an iframe) fails closed with `reason:'frame'` instead of
 * returning a child-frame-relative selector, and a point outside the currently visible viewport
 * answers `reason:'out-of-viewport'`.
 *
 * Read-only contract: nothing here starts Chromium (`ensure`), enters the Runtime serial queue,
 * claims the single-owner lease, records client metrics, marks agent/human or writes
 * Runtime.lastError. Every CDP call is bounded by ELEMENT_CDP_TIMEOUT_MS, so a hung or detached
 * page degrades to `{element:null,reason:'stale'}` (HTTP 200) instead of a 5xx.
 * ------------------------------------------------------------------------------------------- */

export const ELEMENT_CDP_TIMEOUT_MS = 1500;

export const ELEMENT_COORD_LIMIT = 1e7;

export const ELEMENT_OUTER_HTML_MAX = 240;

export const ELEMENT_TEXT_MAX = 160;

export const ELEMENT_SELECTOR_MAX = 512;

export const ELEMENT_MAX_NODE_WALK = 5;

/**
 * Selector / outerHTML / text reads, executed once in the page via `Runtime.callFunctionOn`.
 * `this` is the hit element. The selector is a robust CSS path: a unique id wins, otherwise an
 * ancestor path with `nth-of-type` disambiguation is built and each candidate is re-checked for
 * uniqueness against the node's own root (so a shadow-root pick never cites a document selector).
 */

export const ELEMENT_SELECTOR_JS = `function () {
  var el = this;
  if (!el || el.nodeType !== 1) return null;
  function rootOf(node) {
    return typeof node.getRootNode === 'function' ? node.getRootNode() : document;
  }
  function idOf(node) {
    return node && node.getAttribute ? node.getAttribute('id') : null;
  }
  function selectorFor(node) {
    var scope = rootOf(node);
    function unique(selector) {
      try { return scope.querySelectorAll(selector).length === 1 && scope.querySelector(selector) === node; }
      catch (error) { return false; }
    }
    function simple(n) {
      var id = idOf(n);
      if (id) {
        var idSelector = '#' + CSS.escape(id);
        if (scope.querySelectorAll(idSelector).length === 1) return idSelector;
      }
      var tag = String(n.localName || '').toLowerCase();
      var parent = n.parentElement;
      if (parent) {
        var same = [];
        for (var i = 0; i < parent.children.length; i += 1) {
          if (String(parent.children[i].localName || '').toLowerCase() === tag) same.push(parent.children[i]);
        }
        if (same.length > 1) return tag + ':nth-of-type(' + (same.indexOf(n) + 1) + ')';
      }
      return tag;
    }
    var selector = null;
    var ownId = idOf(node);
    if (ownId) {
      var own = '#' + CSS.escape(ownId);
      if (unique(own)) selector = own;
    }
    if (!selector) {
      var parts = [];
      var current = node;
      for (var depth = 0; current && current.nodeType === 1 && depth < 8; depth += 1) {
        parts.unshift(simple(current));
        var candidate = parts.join(' > ');
        // Prefer an anchored path: a bare tag / nth-of-type candidate is unique only by accident,
        // so a non-id selector must carry at least one ancestor segment.
        if (unique(candidate) && (parts.length >= 2 || candidate.charAt(0) === '#')) { selector = candidate; break; }
        if (idOf(current)) break;
        current = current.parentElement;
      }
      if (!selector && parts.length) selector = parts.join(' > ');
    }
    return selector;
  }
  function uniqueFor(selector, node) {
    if (!selector) return false;
    try {
      var scope = rootOf(node);
      return scope.querySelectorAll(selector).length === 1 && scope.querySelector(selector) === node;
    } catch (error) {
      return false;
    }
  }
  var root = rootOf(el);
  var host = root && root.host ? root.host : null;
  var finalSelector = selectorFor(el);
  return {
    selector: finalSelector,
    // 'unique' means the selector resolves to exactly this node in its own root; 'degraded' means
    // the path fell back to tag/nth-of-type candidates and must not be used as a standalone locator.
    selectorQuality: finalSelector ? (uniqueFor(finalSelector, el) ? 'unique' : 'degraded') : 'none',
    outerHTML: el.outerHTML == null ? '' : String(el.outerHTML),
    text: el.textContent == null ? '' : String(el.textContent),
    // Shadow-DOM facts (detail only, best effort): the selector above is ROOT-scoped when the hit
    // lives in a shadow root, so document.querySelector(selector) cannot find it; the host facts
    // let a caller describe the target anyway, and closedShadow says whether the root is closed.
    shadowHost: host ? {
      tag: String(host.localName || '').toLowerCase(),
      id: idOf(host) || '',
      selector: selectorFor(host),
    } : null,
    closedShadow: host ? root.mode === 'closed' : null,
  };
}`;

/** Validate the write-free request shape: `{x, y, detail?}` with document CSS px coordinates. */

/** Validate the write-free request shape: `{x, y, detail?}` with document CSS px coordinates. */
export function elementPickRequest(body) {
  if (!body || typeof body !== 'object' || Array.isArray(body)) {
    throw new BrowserError('INVALID_ARGUMENT', 'element 请求体必须是 JSON 对象', { field: 'body' });
  }
  const coordinate = (field) => {
    const value = body[field];
    if (typeof value !== 'number' || !Number.isFinite(value) || Math.abs(value) > ELEMENT_COORD_LIMIT) {
      throw new BrowserError('INVALID_ARGUMENT', `element ${field} 必须是 |v|≤${ELEMENT_COORD_LIMIT} 的有限数`, {
        field, valueType: value === null ? 'null' : typeof value,
      });
    }
    return value;
  };
  const x = coordinate('x');
  const y = coordinate('y');
  if (body.detail !== undefined && body.detail !== null && typeof body.detail !== 'boolean') {
    throw new BrowserError('INVALID_ARGUMENT', 'element detail 必须是布尔值', { field: 'detail', valueType: typeof body.detail });
  }
  const cursorOnly = body.cursorOnly === true;
  // A cursor-only probe answers just the computed `cursor` of the hit: it exists so the panel can
  // mirror the page's hand/text/grab cursor onto the preview while the pointer moves, without
  // paying for the box model, frame tree and selector work a full pick needs.
  return { x, y, detail: body.detail === true, cursorOnly };
}

/**
 * Collapse whitespace and cut to `max` code points (never split a surrogate pair).
 * The cut is explicit: a trailing ellipsis plus `truncated/length` facts keep the consumer from
 * mistaking a display truncation for a malformed element (TOOL: element picker).
 */

export function elementCut(value, max) {
  const collapsed = String(value == null ? '' : value).replace(/\s+/gu, ' ').trim();
  const chars = Array.from(collapsed);
  const truncated = chars.length > max;
  return {
    text: truncated ? chars.slice(0, max).join('') + '…' : collapsed,
    truncated,
    length: chars.length,
  };
}

/** Flat `attributes` array from DOM.describeNode -> plain object (last duplicate wins). */

/** Flat `attributes` array from DOM.describeNode -> plain object (last duplicate wins). */
export function elementAttributes(node) {
  const out = {};
  const list = Array.isArray(node && node.attributes) ? node.attributes : [];
  for (let index = 0; index + 1 < list.length; index += 2) {
    out[String(list[index])] = String(list[index + 1]);
  }
  return out;
}

/**
 * The frame a pick belongs to, read from the `Page.getFrameTree` reply.
 *
 * `main` marks the root frame; a nested frame carries its own `loaderId` (document generation) and
 * URL so the reply can say that the selector/rect are scoped to that document. An id absent from
 * the tree answers `null`: the caller fails closed instead of trusting an unverifiable frame.
 */

export function elementFrameOf(frameTree, frameId) {
  const wanted = String(frameId || '');
  if (!wanted || !frameTree || !frameTree.frame) return null;
  const walk = (node, depth) => {
    if (!node || !node.frame || depth > 32) return null;
    if (String(node.frame.id) === wanted) {
      return {
        id: String(node.frame.id),
        loaderId: typeof node.frame.loaderId === 'string' ? node.frame.loaderId : null,
        url: typeof node.frame.url === 'string' ? node.frame.url : '',
        main: depth === 0,
      };
    }
    const children = Array.isArray(node.childFrames) ? node.childFrames : [];
    for (const child of children) {
      const found = walk(child, depth + 1);
      if (found) return found;
    }
    return null;
  };
  return walk(frameTree, 0);
}

/** Does this frame tree still carry a document whose loader id is `loaderId`? */

/** Does this frame tree still carry a document whose loader id is `loaderId`? */
export function frameTreeHasLoaderId(frameTree, loaderId) {
  const wanted = String(loaderId || '');
  if (!wanted) return false;
  const walk = (node, depth) => {
    if (!node || !node.frame || depth > 32) return false;
    if (String(node.frame.loaderId || '') === wanted) return true;
    const children = Array.isArray(node.childFrames) ? node.childFrames : [];
    return children.some((child) => walk(child, depth + 1));
  };
  return walk(frameTree, 0);
}

/** Border-box quad (viewport CSS px) -> document rect; a degenerate/absent quad is `null`. */

/** Border-box quad (viewport CSS px) -> document rect; a degenerate/absent quad is `null`. */
export function elementQuadRect(model, scrollX, scrollY) {
  const quad = model && (model.border || model.padding || model.content);
  if (!Array.isArray(quad) || quad.length < 8) return null;
  const xs = [quad[0], quad[2], quad[4], quad[6]];
  const ys = [quad[1], quad[3], quad[5], quad[7]];
  const minX = Math.min(...xs);
  const minY = Math.min(...ys);
  const maxX = Math.max(...xs);
  const maxY = Math.max(...ys);
  return {
    x: minX + scrollX,
    y: minY + scrollY,
    width: maxX - minX,
    height: maxY - minY,
  };
}

/**
 * `detail:true` extras. Both halves are best-effort: a failed resolve/AX read leaves the fact
 * null instead of turning the hit into an error (the panel can still show tag/rect).
 */

export async function elementDetailFacts(cdp, backendNodeId) {
  const bounded = (method, params) => cdp.send(method, params, { timeoutMs: ELEMENT_CDP_TIMEOUT_MS });
  const facts = {
    selector: null, selectorQuality: null, outerHTML: null, outerHTMLTruncated: false, outerHTMLLength: null,
    text: null, textTruncated: false, textLength: null, role: null, name: null, shadowHost: null, closedShadow: null,
  };
  try {
    const resolved = await bounded('DOM.resolveNode', { backendNodeId });
    const objectId = resolved && resolved.object ? resolved.object.objectId : null;
    if (objectId) {
      const evaluated = await bounded('Runtime.callFunctionOn', {
        objectId, returnByValue: true, functionDeclaration: ELEMENT_SELECTOR_JS,
      });
      const value = evaluated && evaluated.result ? evaluated.result.value : null;
      if (value && typeof value === 'object') {
        facts.selector = typeof value.selector === 'string' && value.selector
          ? Array.from(value.selector).slice(0, ELEMENT_SELECTOR_MAX).join('')
          : null;
        facts.selectorQuality = value.selectorQuality === 'unique' || value.selectorQuality === 'degraded'
          || value.selectorQuality === 'none' ? value.selectorQuality : null;
        if (typeof value.outerHTML === 'string') {
          const outer = elementCut(value.outerHTML, ELEMENT_OUTER_HTML_MAX);
          facts.outerHTML = outer.text;
          facts.outerHTMLTruncated = outer.truncated;
          facts.outerHTMLLength = outer.length;
        }
        if (typeof value.text === 'string') {
          const text = elementCut(value.text, ELEMENT_TEXT_MAX);
          facts.text = text.text;
          facts.textTruncated = text.truncated;
          facts.textLength = text.length;
        }
        const host = value.shadowHost && typeof value.shadowHost === 'object' ? value.shadowHost : null;
        facts.shadowHost = host ? {
          tag: String(host.tag || ''),
          id: String(host.id || ''),
          selector: typeof host.selector === 'string' && host.selector
            ? Array.from(host.selector).slice(0, ELEMENT_SELECTOR_MAX).join('')
            : null,
        } : null;
        facts.closedShadow = typeof value.closedShadow === 'boolean' ? value.closedShadow : null;
      }
    }
  } catch { /* best-effort: detail never fails the pick */ }
  try {
    const tree = await bounded('Accessibility.getPartialAXTree', { backendNodeId, fetchRelatives: false });
    const node = tree && Array.isArray(tree.nodes) ? tree.nodes[0] : null;
    facts.role = node && node.role && typeof node.role.value === 'string' ? node.role.value : null;
    facts.name = node && node.name && typeof node.name.value === 'string' ? node.name.value : null;
  } catch { /* best-effort */ }
  return facts;
}

/**
 * Read the element at one document point. Never throws and never mutates the runtime: the caller
 * turns the result into `{ok:true, element, reason}`.
 */

export async function pickElementAt(runtime, { x, y, detail, cursorOnly = false }) {
  if (!runtime || !runtime.running || !runtime.cdp) return { element: null, reason: 'no-page' };
  const cdp = runtime.cdp;
  const bounded = (method, params) => cdp.send(method, params, { timeoutMs: ELEMENT_CDP_TIMEOUT_MS });
  try {
    // Layout metrics are both the scroll source for the document rect and the visible-area
    // boundary for the hit test (`DOM.getNodeForLocation` only hits what is on screen).
    const metrics = await bounded('Page.getLayoutMetrics', {});
    const viewport = (metrics && (metrics.cssLayoutViewport || metrics.layoutViewport || metrics.visualViewport)) || {};
    const scrollX = Number.isFinite(viewport.pageX) ? viewport.pageX : 0;
    const scrollY = Number.isFinite(viewport.pageY) ? viewport.pageY : 0;
    const width = Number.isFinite(viewport.clientWidth) ? viewport.clientWidth : null;
    const height = Number.isFinite(viewport.clientHeight) ? viewport.clientHeight : null;
    // Half-open visible box. Answering `out-of-viewport` is a better diagnostic than a generic
    // miss: the panel only ever hover-tests points that are on screen anyway.
    if (width !== null && height !== null
      && (x < scrollX || y < scrollY || x >= scrollX + width || y >= scrollY + height)) {
      return { element: null, reason: 'out-of-viewport' };
    }
    let hit;
    try {
      // Document coordinates, floored: the protocol rejects fractions, and only the hit test is
      // quantised (nothing is dispatched and nothing is mutated).
      hit = await bounded('DOM.getNodeForLocation', {
        x: Math.floor(x), y: Math.floor(y),
        // Native controls contain browser-owned shadow nodes (e.g. select's inner DIV).
        // Pick the authored control so its options and identity can be read. This flag only
        // excludes UA shadow; authored open/closed shadow roots keep their existing behavior.
        includeUserAgentShadowDOM: false, ignorePointerEventsNone: false,
      });
    } catch (error) {
      // "No node found at given location" is a miss; a timeout / detached document / closed CDP
      // is a stale read. Neither may reach the top-level error projection.
      const noNode = /no node found/i.test(String((error && error.message) || ''));
      return { element: null, reason: noNode ? 'no-hit' : 'stale' };
    }
    if (!hit || !Number.isInteger(hit.backendNodeId)) return { element: null, reason: 'no-hit' };
    // A hit may land in a same-process child frame: a native `<select>` inside an `<iframe>` still
    // needs the picker's popover, and `DOM.getBoxModel` already reports ROOT-frame viewport quads,
    // so the document rect stays comparable with the panel's coordinates. Only what cannot be
    // verified is refused: an unknown main frame id (mid-navigation) is `stale`, and a hit whose
    // frame is missing from the frame tree (read below) is `stale` too — never unchecked cross-frame
    // data. OOPIF/closed targets simply never hit on this session.
    if (hit.frameId && !runtime.mainFrameId) return { element: null, reason: 'stale' };
    const described = await bounded('DOM.describeNode', { backendNodeId: hit.backendNodeId, depth: 0 });
    // A hit may land on a text (or shadow-root) node: walk up to its element, bounded.
    let node = described && described.node;
    for (let depth = 0; node && node.nodeType !== 1 && depth <= ELEMENT_MAX_NODE_WALK; depth += 1) {
      if (!node.parentId) { node = null; break; }
      const parent = await bounded('DOM.describeNode', { nodeId: node.parentId, depth: 0 });
      node = parent && parent.node;
    }
    if (!node || node.nodeType !== 1) return { element: null, reason: 'no-hit' };
    // List-style selects hit their OPTION/OPTGROUP rather than the control's border. Project the
    // owning control too, so unsupported shapes can show the keyboard hint instead of disappearing.
    if (['option', 'optgroup'].includes(String(node.localName || '').toLowerCase())) {
      const handles = [];
      try {
        const resolved = await bounded('DOM.resolveNode', { backendNodeId: node.backendNodeId });
        const objectId = resolved?.object?.objectId;
        if (objectId) {
          handles.push(objectId);
          const owner = await bounded('Runtime.callFunctionOn', {
            objectId, functionDeclaration: 'function () { return this.closest("select"); }',
          });
          if (owner?.result?.objectId) {
            handles.push(owner.result.objectId);
            const describedOwner = await bounded('DOM.describeNode', { objectId: owner.result.objectId, depth: 0 });
            if (describedOwner?.node?.localName === 'select') node = describedOwner.node;
          }
        }
      } finally {
        for (const objectId of handles) {
          try { await bounded('Runtime.releaseObject', { objectId }); } catch { /* best effort */ }
        }
      }
    }
    const tag = String(node.localName || '').toLowerCase();
    if (cursorOnly) {
      // Empty page background is a legitimate cursor answer (`default`), not a miss: the panel is
      // asking "what would the real page show here", and a straight arrow is a real answer.
      const cursor = ['html', 'body'].includes(tag)
        ? { cursor: 'default', tag: tag || 'html' }
        : await cursorProjectionAt(bounded, node.backendNodeId);
      return { element: cursor, cursorOnly: true };
    }
    // A point on empty page background resolves to <html>/<body>; for a picker that is "nothing".
    if (!tag || tag === 'html' || tag === 'body') return { element: null, reason: 'no-hit' };
    const box = await bounded('DOM.getBoxModel', { backendNodeId: node.backendNodeId });
    // Loader id = the document generation the hit belongs to (the panel uses it to discard a
    // response that raced a navigation). The frame tree read also proves that a child-frame hit
    // still belongs to a live frame; `main` separates the root frame from a nested one.
    let frame = null;
    try {
      const tree = await bounded('Page.getFrameTree', {});
      frame = elementFrameOf(tree && tree.frameTree, hit.frameId || runtime.mainFrameId);
    } catch { frame = null; }
    // An unreadable frame tree keeps the historical best-effort shape for root-frame hits (no
    // loaderId), but a nested hit without a verifiable frame is refused.
    if (!frame && hit.frameId && hit.frameId !== runtime.mainFrameId) return { element: null, reason: 'stale' };
    const loaderId = frame && typeof frame.loaderId === 'string' && frame.loaderId ? frame.loaderId : null;
    const attributes = elementAttributes(node);
    const element = {
      tag,
      id: attributes.id || '',
      classes: attributes.class ? attributes.class.split(/\s+/u).filter(Boolean) : [],
      rect: elementQuadRect(box && box.model, scrollX, scrollY),
      frameId: String(hit.frameId || runtime.mainFrameId || ''),
      // Nested frames only: the selector/outerHTML above are valid inside that frame's document,
      // not in the main document, so the caller gets the frame identity instead of guessing.
      ...(frame && frame.main === false ? { frame: { id: frame.id, url: redactUrl(frame.url), main: false } } : {}),
      // The SAME Page.getLayoutMetrics read that produced the document rect: the panel compares it
      // with its own view to detect a response computed while the page was still scrolling.
      scroll: { x: scrollX, y: scrollY },
      ...(loaderId ? { loaderId } : {}),
      page: {
        url: runtime.url ? redactUrl(runtime.url) : '',
        title: runtime.title ? String(runtime.title) : '',
      },
    };
    if (detail) {
      Object.assign(element, await elementDetailFacts(cdp, node.backendNodeId));
      // The picker's own preview mirrors the page cursor from the hit it already has.
      const pointer = await cursorProjectionAt(bounded, node.backendNodeId);
      if (pointer) element.cursor = pointer.cursor;
    }
    // A native <select> popup is painted by the browser UI layer, never by the page, so the panel
    // cannot see it in the frame. Only for a select hit (and only when the projection is readable)
    // does the reply gain a `select` field; every other hit keeps the exact historical shape.
    if (tag === 'select') {
      const select = await selectProjectionAt(bounded, node.backendNodeId);
      if (select) element.select = {
        ...select,
        ...(loaderId ? { target: { backendNodeId: node.backendNodeId, loaderId } } : {}),
      };
    }
    return { element };
  } catch {
    // Any other read failure (CDP timeout/disconnect, detached target, missing box) is stale.
    return { element: null, reason: 'stale' };
  }
}

/**
 * Computed `cursor` of one hit node (POST /element `cursorOnly`, and the detail projection).
 *
 * Read-only and failure-tolerant, exactly like `selectProjectionAt`: one `DOM.resolveNode` plus one
 * `Runtime.callFunctionOn` that only reads, `null` on any failure, so an unreadable node never turns
 * a successful hover into an error. The value passes through verbatim — the CLIENT decides which
 * keywords it is willing to apply, because `cursor:url(...)` must never reach a style attribute.
 */

export async function cursorProjectionAt(bounded, backendNodeId) {
  let objectId = null;
  try {
    const resolved = await bounded('DOM.resolveNode', { backendNodeId });
    objectId = resolved && resolved.object ? resolved.object.objectId : null;
    if (!objectId) return null;
    const answer = await bounded('Runtime.callFunctionOn', {
      objectId,
      functionDeclaration: 'function () { return String(getComputedStyle(this).cursor || "") }',
      returnByValue: true,
    });
    const value = answer && answer.result ? answer.result.value : null;
    if (typeof value !== 'string' || !value) return null;
    return { cursor: value.slice(0, 64) };
  } catch {
    return null;
  } finally {
    if (objectId) {
      try { await bounded('Runtime.releaseObject', { objectId }); } catch { /* best effort */ }
    }
  }
}

/**
 * Read-only option projection for a hit `<select>` (POST /element).
 *
 * Same read-only contract as `pickElementAt` (no ensure, no queue, no lease, no `lastError`): one
 * `DOM.resolveNode` + one `Runtime.callFunctionOn` that merely reads. Every failure answers `null`
 * so the element reply keeps its historical shape — a page that cannot be read must not turn a
 * successful pick into an error, and a non-select hit must never grow a new field.
 */

export async function selectProjectionAt(bounded, backendNodeId) {
  let objectId = null;
  try {
    const resolved = await bounded('DOM.resolveNode', { backendNodeId });
    objectId = resolved && resolved.object ? resolved.object.objectId : null;
    if (!objectId) return null;
    const answer = await bounded('Runtime.callFunctionOn', {
      objectId,
      functionDeclaration: selectProbeDeclaration(),
      returnByValue: true,
    });
    const value = answer && answer.result ? answer.result.value : null;
    return normalizeSelectProjection(value);
  } catch {
    return null;
  } finally {
    // CallFunctionOn leaves a remote handle behind; releasing it is best-effort and must never
    // mask the read result (a dropped handle only costs the inspector's object group).
    if (objectId) {
      try { await bounded('Runtime.releaseObject', { objectId }); } catch { /* best effort */ }
    }
  }
}

/** Register the runtime, its HTTP surface, and the agent tools. */
