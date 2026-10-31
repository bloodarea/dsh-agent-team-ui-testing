/**
 * Host half of the UI testing plugin: owns a real headless Chromium and drives it over CDP.
 * The client half only renders frames and forwards input, so nothing here can steal window focus.
 */
import { spawn } from 'node:child_process';
import { readFileSync } from 'node:fs';
import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, sep } from 'node:path';
import { fileURLToPath } from 'node:url';
import { FrameSource } from './frame-source.js';
import { attachFramePush } from './frame-push.js';
import { createHash, randomUUID } from 'node:crypto';
import { BrowserError, Cdp, asBrowserError, checkAbort, abortable, redactUrl, redactText, validateTarget } from './browser-safety.js';
export { BrowserError, Cdp } from './browser-safety.js';

export const inject = ['tools', 'webServer'];

const CHROME_BIN = process.env.DSH_UI_TESTING_CHROME || '/opt/google/chrome/chrome';
const ROUTE_PREFIX = '/plugins/ui-testing';
const NETWORK_LIMIT = 300;
const AGENT_HOLD_MS = 15000;
/** How long a reload / history command may take to commit its main-frame navigation. */
const COMMIT_TIMEOUT_MS = 10000;
/** Throttle for the merged background title/url/history read (UI polls at 500ms / 80ms). */
const METADATA_THROTTLE_MS = 250;
const SKILL_NAME = 'ui-testing';
const SKILL_DIR = fileURLToPath(new URL('./skills/ui-testing/', import.meta.url));
const SKILL_FALLBACK_DESCRIPTION =
  'Web T1 browser debugging through the bundled structured tools (browser_navigate, browser_eval, ' +
  'browser_input, browser_network, browser_computed_style, browser_screenshot, browser_state, browser_capabilities). ' +
  'Use for authorized web UI inspection, interaction and verification; T2-T4 are not implemented.';

/**
 * CDP Input modifier bitmask: Alt=1, Ctrl=2, Meta=4, Shift=8 (see Input.dispatchKeyEvent).
 * `browser_input` accepts either the string form ['alt','ctrl','meta','shift'] or the raw mask.
 */
const MODIFIER_BITS = Object.freeze({ alt: 1, ctrl: 2, meta: 4, shift: 8 });
const MODIFIER_MASK = Object.values(MODIFIER_BITS).reduce((mask, bit) => mask | bit, 0);
/** Key event types the CDP Input domain actually accepts. */
const KEY_EVENT_TYPES = Object.freeze(['keyDown', 'keyUp', 'rawKeyDown', 'char']);
/** CDP pointer types (Input.dispatchMouseEvent.pointerType). */
const POINTER_TYPES = Object.freeze({ mouse: 1, pen: 2 });

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

function normalizePointerType(value) {
  if (value === undefined || value === null) return undefined;
  if (typeof value === 'string' && POINTER_TYPES[value.trim().toLowerCase()]) return POINTER_TYPES[value.trim().toLowerCase()];
  if (Number.isInteger(value) && Object.values(POINTER_TYPES).includes(value)) return value;
  throw new BrowserError('INVALID_ARGUMENT', 'pointerType 只支持 mouse/pen（或 CDP 的 1/2）');
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
    if (clean !== undefined) out[key] = clean;
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
  });
  return projected.attachmentId || projected.id ? projected : undefined;
}

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

/** One headless browser plus the page being previewed. */
export class Runtime {
  constructor(log) {
    this.log = log;
    this.proc = undefined;
    this.cdp = undefined;
    this.browserCdp = undefined;
    this.profileDir = undefined;
    this.port = 0;
    this.frames = new FrameSource();
    this.frameTransport = undefined;
    this.clientMetrics = undefined;
    this.ackFailures = 0;
    this.cdpOff = undefined;
    this.closing = false;
    this.network = [];
    this.requests = new Map();
    this.url = '';
    this.title = '';
    this.viewport = { width: 1280, height: 800 };
    this.activity = '空闲';
    this.agentUntil = 0;
    this.humanUntil = 0;
    this.lastError = '';
    this.starting = undefined;
    this.queue = Promise.resolve();
    this.lease = undefined;
    this.active = 0;
    this.origins = new Set();
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
  }

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

  async run(operation, { signal, sessionId = 'anonymous', agent = false } = {}) {
    checkAbort(signal);
    if (agent) { this.claim(sessionId); this.activeOwner = sessionId; this.active += 1; }
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
      return result;
    } catch (error) {
      const classified = asBrowserError(error);
      // A rejected CDP wait cannot retract an already dispatched command. Close before allowing
      // the next writer, rather than letting that command mutate a later operation's page.
      if (entered && ['ABORTED', 'CDP_TIMEOUT', 'CDP_DISCONNECTED'].includes(classified.code)) await this.close();
      throw classified;
    } finally {
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
    if (this.cdp && !this.cdp.closed) return this.cdp;
    if (this.starting) return abortable(this.starting, signal);
    if (this.proc || this.profileDir) await this.close();
    this.starting = this.#start(signal).finally(() => { this.starting = undefined; });
    return this.starting;
  }

  async #start(signal) {
    const profileDir = await mkdtemp(join(tmpdir(), 'dsh-ui-testing-'));
    this.profileDir = profileDir;
    let proc;
    try {
      proc = spawn(CHROME_BIN, [
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
        this.cdp = undefined;
      });

      const devtoolsFile = join(profileDir, 'DevToolsActivePort');
      let port = 0;
      for (let attempt = 0; attempt < 100; attempt += 1) {
        checkAbort(signal);
        if (spawnError || proc.exitCode !== null) throw new BrowserError('CDP_DISCONNECTED', spawnError?.message || 'Chromium 启动进程提前退出');
        try {
          const text = await readFile(devtoolsFile, 'utf8');
          port = Number(text.split('\n')[0]);
          if (port) break;
        } catch { /* not ready yet */ }
        await new Promise((resolve) => setTimeout(resolve, 100));
      }
      if (!port) throw new Error('Chromium 未在预期时间内启动（DevToolsActivePort 不存在）');
      this.port = port;

      const list = await fetch(`http://127.0.0.1:${port}/json/list`, { signal }).then((response) => response.json());
      const page = list.find((target) => target.type === 'page');
      if (!page) throw new Error('Chromium 没有可用的 page target');

      const version = await fetch(`http://127.0.0.1:${port}/json/version`, { signal }).then((response) => response.json());
      const browserCdp = new Cdp(version.webSocketDebuggerUrl);
      await browserCdp.connect({ signal });
      this.browserCdp = browserCdp;
      const secondary = new Set();
      browserCdp.on((message) => {
        if (message.method === 'Fetch.requestPaused' && secondary.has(message.sessionId)) {
          browserCdp.send('Fetch.failRequest', { requestId: message.params.requestId, errorReason: 'BlockedByClient' }, { sessionId: message.sessionId }).catch(() => {});
          return;
        }
        if (message.method === 'Target.detachedFromTarget') { secondary.delete(message.params.sessionId); return; }
        if (message.method !== 'Target.attachedToTarget') return;
        const { targetInfo, sessionId } = message.params;
        if (targetInfo.type === 'page' && targetInfo.targetId !== page.id) {
          // Install fail-all interception BEFORE resuming. Destroying a paused popup strands
          // the opener's synchronous window.open, so let it resume with networking blocked.
          secondary.add(sessionId);
          browserCdp.send('Fetch.enable', { patterns: [{ urlPattern: '*' }] }, { sessionId })
            .then(() => browserCdp.send('Runtime.runIfWaitingForDebugger', {}, { sessionId }))
            .then(() => {
              const timer = setTimeout(() => browserCdp.send('Target.closeTarget', { targetId: targetInfo.targetId }).catch(() => {}), 100);
              timer.unref?.();
            }).catch(() => browserCdp.send('Target.closeTarget', { targetId: targetInfo.targetId }).catch(() => {}));
        } else browserCdp.send('Runtime.runIfWaitingForDebugger', {}, { sessionId })
          .then(() => browserCdp.send('Target.detachFromTarget', { sessionId })).catch(() => {});
      });
      await browserCdp.send('Target.setAutoAttach', { autoAttach: true, waitForDebuggerOnStart: true, flatten: true,
        filter: [{ type: 'page', exclude: false }] }, { signal });
      const cdp = new Cdp(page.webSocketDebuggerUrl);
      await cdp.connect({ signal });
      this.cdp = cdp;
      // A new CDP connection invalidates any metadata read still in flight from the old one.
      this.metadataGeneration += 1;
      this.cdpOff = cdp.on((message) => this.#onEvent(message));

      await this.send('Page.enable', {}, signal);
      await this.send('Runtime.enable', {}, signal);
      await this.send('Network.enable', { maxTotalBufferSize: 5000000 }, signal);
      await this.send('Fetch.enable', { patterns: [{ urlPattern: '*', resourceType: 'Document', requestStage: 'Request' }] }, signal);
      await this.send('DOM.enable', {}, signal);
      await this.send('CSS.enable', {}, signal);
      // Same-document navigations are only meaningful for the main frame; remember which one it is.
      const tree = await this.send('Page.getFrameTree', {}, signal);
      this.mainFrameId = tree && tree.frameTree && tree.frameTree.frame ? tree.frameTree.frame.id : undefined;
      await this.applyViewport(this.viewport.width, this.viewport.height, signal);
      await cdp.send('Page.startScreencast', {
        format: 'jpeg',
        quality: 72,
        maxWidth: 1600,
        maxHeight: 1200,
        everyNthFrame: 1,
      }, { signal });
      // Publish the fresh runtime state (history/url/title) once the browser is up.
      this.refreshMetadataSoon();
      this.log(`chromium ready on devtools port ${port}`);
      return cdp;
    } catch (error) {
      // A failed start must not leave a Chromium process or profile directory behind.
      try { if (this.cdpOff) this.cdpOff(); } catch { /* ignore */ }
      this.cdpOff = undefined;
      try { if (this.cdp) this.cdp.close(); } catch { /* ignore */ }
      try { this.browserCdp?.close(); } catch { /* ignore */ }
      this.browserCdp = undefined;
      this.cdp = undefined;
      if (proc && proc.exitCode === null) {
        try { proc.kill('SIGKILL'); } catch { /* ignore */ }
      }
      this.proc = undefined;
      this.profileDir = undefined;
      this.port = 0;
      if (proc) await waitForExit(proc, 500);
      // profileDir is the exact absolute directory returned by mkdtemp above.
      try { await rm(profileDir, { recursive: true, force: true }); } catch { /* ignore */ }
      throw error;
    }
  }

  #onEvent(message) {
    if (message.method === 'Fetch.requestPaused') {
      const cdp = this.cdp;
      const { requestId, request } = message.params;
      validateTarget(request.url, { origins: [...this.origins] }).then(
        () => cdp.send('Fetch.continueRequest', { requestId }),
        (error) => {
          this.navigationError = new BrowserError('NAV_FAILED', error.message, { url: redactUrl(request.url) });
          this.lastError = this.navigationError.message;
          return cdp.send('Fetch.failRequest', { requestId, errorReason: 'BlockedByClient' });
        },
      ).catch(() => {});
      return;
    }
    if (['Page.loadEventFired', 'Page.domContentEventFired'].includes(message.method)) {
      this.refreshMetadataSoon();
      return;
    }
    if (message.method === 'Page.screencastFrame') {
      const params = message.params;
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
        this.cdp.send('Page.screencastFrameAck', { sessionId: params.sessionId }).catch((error) => {
          this.ackFailures += 1;
          this.log('screencast ack failed: ' + String((error && error.message) || error));
        });
      }
      return;
    }
    if (message.method === 'Page.frameNavigated' && message.params.frame.parentId === undefined) {
      const frame = message.params.frame;
      this.mainFrameId = frame.id;
      const fragment = typeof frame.urlFragment === 'string' && frame.urlFragment && !String(frame.url).includes('#')
        ? '#' + frame.urlFragment
        : '';
      this.url = String(frame.url || '') + fragment;
      this.title = '';
      this.metadataGeneration += 1;
      this.frames.markNavigation(redactUrl(this.url));
      this.refreshMetadataSoon();
      return;
    }
    if (message.method === 'Page.navigatedWithinDocument') {
      // pushState / replaceState / hash change / popstate in the main frame only: a child iframe
      // must never rewrite the address bar, and a same-document navigation is not a new epoch.
      if (message.params.frameId === this.mainFrameId) {
        this.url = String(message.params.url || this.url);
        this.metadataGeneration += 1;
        this.refreshMetadataSoon();
      }
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

  async applyViewport(width, height, signal) {
    if (!Number.isFinite(width) || !Number.isFinite(height)) throw new BrowserError('INVALID_ARGUMENT', '视口尺寸必须是有限数字');
    const w = Math.max(200, Math.min(4096, Math.round(width)));
    const h = Math.max(200, Math.min(4096, Math.round(height)));
    this.viewport = { width: w, height: h };
    await this.send('Emulation.setDeviceMetricsOverride', {
      width: w,
      height: h,
      deviceScaleFactor: 1,
      mobile: false,
    }, signal);
    return this.viewport;
  }

  touchHuman(ms = 4000) {
    this.humanUntil = Date.now() + ms;
    this.activity = '人类正在操作浏览器';
  }

  touchAgent(text) {
    this.agentUntil = Date.now() + AGENT_HOLD_MS;
    this.activity = text;
  }

  state() {
    return {
      mode: this.mode(),
      activity: redactText(this.activity),
      url: this.url ? redactUrl(this.url) : '',
      owner: { mode: 'single-owner-lease', sessionId: this.lease && (this.active || this.lease.expiresAt > Date.now()) ? this.lease.sessionId : null },
      title: this.title,
      viewport: this.viewport,
      seq: this.frames.seq,
      running: Boolean(this.cdp && !this.cdp.closed),
      error: redactText(this.lastError),
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
        address: running ? this.url : '',
        history: { ...(running ? this.history : emptyHistory()) },
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
    const host = { ...this.frames.metrics(), ackFailures: this.ackFailures, push };
    if (push) {
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
    const result = await this.send('Page.navigate', { url: target }, signal);
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
    this.lastError = '';
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
    this.lastError = '';
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
    this.lastError = '';
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

  async traffic(limit) {
    const size = Math.max(1, Math.min(Number.isFinite(limit) ? Math.floor(limit) : 50, NETWORK_LIMIT));
    return { entries: this.network.slice(-size) };
  }

  async close() {
    if (this.closing) return;
    this.closing = true;
    // Invalidate every metadata read still in flight: after close no old URL may be republished.
    this.metadataGeneration += 1;
    this.metadataInFlight = false;
    this.metadataDirty = false;
    if (this.metadataRetryTimer) { clearTimeout(this.metadataRetryTimer); this.metadataRetryTimer = 0; }
    this.mainFrameId = undefined;
    this.history = emptyHistory();
    // Do not race a lazily starting browser: let it settle, then tear the result down.
    if (this.starting) {
      try { await this.starting; } catch { /* start failure already cleaned up */ }
    }
    try { if (this.frameTransport) this.frameTransport.closeClients(); } catch { /* ignore */ }
    try { if (this.cdp && !this.cdp.closed) await this.cdp.send('Page.stopScreencast', {}, { timeoutMs: 200 }); } catch { /* ignore */ }
    try { if (this.cdpOff) this.cdpOff(); } catch { /* ignore */ }
    this.cdpOff = undefined;
    try { if (this.cdp) this.cdp.close(); } catch { /* ignore */ }
    try { this.browserCdp?.close(); } catch { /* ignore */ }
    this.browserCdp = undefined;
    this.cdp = undefined;

    const proc = this.proc;
    this.proc = undefined;
    const dir = this.profileDir;
    this.profileDir = undefined;
    if (proc) {
      try { proc.kill('SIGTERM'); } catch { /* ignore */ }
      const exited = await waitForExit(proc, 1200);
      if (!exited) {
        try { proc.kill('SIGKILL'); } catch { /* ignore */ }
        await waitForExit(proc, 500);
      }
    }
    if (dir) {
      try { await rm(dir, { recursive: true, force: true }); } catch { /* ignore */ }
    }

    this.frames.stop();
    this.network.length = 0;
    this.requests.clear();
    this.url = '';
    this.title = '';
    this.lastError = '';
    this.activity = '空闲';
    this.port = 0;
    this.ackFailures = 0;
    this.clientMetrics = undefined;
    this.lease = undefined;
    this.agentUntil = 0;
    this.humanUntil = 0;
    this.metadataStartedAt = 0;
    this.navigationError = undefined;
    this.closing = false;
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

/** Register the runtime, its HTTP surface, and the agent tools. */
export function apply(ctx) {
  const log = (text) => {
    try {
      if (ctx.logger && typeof ctx.logger.info === 'function') ctx.logger.info(text);
    } catch { /* logging must never break the runtime */ }
  };
  const runtime = new Runtime(log);
  let attachments;
  ctx.inject(['attachments'], (sub) => {
    attachments = sub.attachments;
    sub.effect(() => () => { attachments = undefined; }, 'ui-testing: attachments');
  });
  if (typeof ctx.on === 'function') ctx.on('agent/disposed', ({ agent }) => runtime.release(String(agent.id)));

  ctx.effect(() => () => { runtime.close().catch(() => {}); }, 'ui-testing: browser runtime');

  // Same-origin WebSocket push is an optimisation over the polling fallback: a failure to
  // mount it (e.g. an exotic HTTP setup) must leave the /frame polling transport working.
  ctx.effect(() => {
    let transport;
    try {
      transport = attachFramePush(ctx, runtime.frames, { log });
    } catch (error) {
      log('ui-testing frame push unavailable: ' + String((error && error.message) || error));
      return () => {};
    }
    runtime.frameTransport = transport;
    return () => {
      runtime.frameTransport = undefined;
      transport.dispose();
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

  // The GUI address bar needs the *real* URL and the *real* CDP history, which are never part of
  // the redacted `state()` tool projection. Serve them only to an authenticated same-origin
  // caller: fail closed, so a missing/erroring connection service never yields a raw address.
  const uiRejection = (req) => {
    let connection;
    try { connection = typeof ctx.get === 'function' ? ctx.get('connection') : undefined; } catch { return 401; }
    if (!connection || typeof connection.requestRejection !== 'function') return 401;
    let rejection;
    try { rejection = connection.requestRejection(req); } catch { return 401; }
    if (rejection === undefined || rejection === null || rejection === false) return 0;
    return rejection === 403 ? 403 : 401;
  };
  /** Authenticated GUI → raw UI projection; everything else keeps the historical redacted state. */
  const projectedState = (req) => (uiRejection(req) === 0 ? runtime.uiState() : runtime.state());
  const rejectUi = (res, status) => {
    // Authentication failures are answered inline: they are not page errors and must not be
    // written into the runtime's lastError / activity.
    const error = new BrowserError('UNSUPPORTED', '需要已认证的 GUI 会话才能访问该运行时接口');
    sendJson(res, status === 403 ? 403 : 401, { ok: false, ...error.payload(), error: error.message });
  };

  const handle = async (req, res) => {
    let action = '/';
    try {
      const url = new URL(req.url || '/', 'http://localhost');
      action = url.pathname.slice(ROUTE_PREFIX.length) || '/';
      if (req.headers?.host) {
        try { runtime.origins.add(new URL('http://' + req.headers.host).origin); } catch { /* invalid host */ }
      }
      if (req.method === 'GET' && action === '/frame') {
        const since = Number(url.searchParams.get('since') || 0) || 0;
        runtime.refreshMetadataSoon();
        sendJson(res, 200, runtime.framePayload(since, projectedState(req)));
        return;
      }
      if (req.method === 'GET' && action === '/state') {
        runtime.refreshMetadataSoon();
        sendJson(res, 200, projectedState(req));
        return;
      }
      if (req.method === 'GET' && action === '/metrics') {
        sendJson(res, 200, runtime.metrics());
        return;
      }
      if (req.method !== 'POST') {
        const error = new BrowserError('INVALID_ARGUMENT', '只支持 GET /frame、/state、/metrics 与 POST 指令');
        sendJson(res, 405, { ok: false, ...error.payload(), error: error.message });
        return;
      }
      const body = await readJson(req);
      if (action === '/metrics') {
        runtime.recordClientMetrics(body);
        sendJson(res, 200, { ok: true, metrics: runtime.metrics() });
        return;
      }
      if (action === '/ensure') {
        await runtime.run(async () => {
          await runtime.ensure();
          if (body.url) await runtime.navigate(String(body.url));
        });
        sendJson(res, 200, { ok: true, state: projectedState(req) });
        return;
      }
      if (action === '/navigate') {
        await runtime.run(() => runtime.navigate(String(body.url || '')));
        sendJson(res, 200, { ok: true, state: projectedState(req) });
        return;
      }
      if (action === '/reload') {
        // Protected: these two routes exist only for the authenticated GUI (the client half
        // already hot-reloaded for old hosts, so they must not be reachable anonymously).
        const rejection = uiRejection(req);
        if (rejection) { rejectUi(res, rejection); return; }
        await runtime.run(() => runtime.reload());
        sendJson(res, 200, { ok: true, state: runtime.uiState() });
        return;
      }
      if (action === '/history') {
        const rejection = uiRejection(req);
        if (rejection) { rejectUi(res, rejection); return; }
        const moved = await runtime.run(() => runtime.historyMove(String(body.direction || '')));
        sendJson(res, 200, { ok: true, moved: moved.moved, state: runtime.uiState() });
        return;
      }
      if (action === '/viewport') {
        const viewport = await runtime.run(async () => {
          await runtime.ensure();
          return runtime.applyViewport(Number(body.width), Number(body.height));
        });
        sendJson(res, 200, { ok: true, viewport });
        return;
      }
      if (action === '/input') {
        const applied = await runtime.run(() => {
          runtime.touchHuman();
          return runtime.input(Array.isArray(body.events) ? body.events : []);
        });
        sendJson(res, 200, { ok: true, applied });
        return;
      }
      if (action === '/eval') {
        const result = await runtime.run(() => runtime.evaluate(String(body.expression || 'undefined')));
        sendJson(res, 200, result.ok === false ? { ...result, ...result.error, error: result.error.message } : result);
        return;
      }
      if (action === '/screenshot') {
        const shot = await runtime.run(() => runtime.screenshot());
        sendJson(res, 200, { ok: true, image: shot.base64, viewport: shot.viewport, capturedAt: shot.capturedAt });
        return;
      }
      if (action === '/close') {
        await runtime.run(() => runtime.close());
        sendJson(res, 200, { ok: true });
        return;
      }
      const error = new BrowserError('UNSUPPORTED', '未知指令 ' + action);
      sendJson(res, 404, { ok: false, ...error.payload(), error: error.message });
    } catch (error) {
      const classified = asBrowserError(error);
      runtime.lastError = classified.message;
      sendJson(res, 500, { ok: false, ...classified.payload(), error: classified.message });
    }
  };

  ctx.effect(() => ctx.webServer.register({ kind: 'prefix', path: ROUTE_PREFIX, handler: handle }), 'ui-testing: http routes');

  const text = (value) => [{ type: 'text', text: typeof value === 'string' ? value : JSON.stringify(value) }];
  const register = (definition) => {
    const execute = definition.execute;
    definition.timeoutMs = 30000;
    definition.execute = async (args, exec = {}) => {
      const sessionId = String(exec.agent?.id || 'anonymous');
      const meta = { actionId: randomUUID(), sessionId, startedAt: Date.now(), tool: definition.name,
        // Expressions and input text may contain secrets: record a bounded structural summary.
        args: Object.fromEntries(Object.entries(args || {}).map(([key, value]) => [key,
          key === 'url' ? redactUrl(String(value))
            : Array.isArray(value) ? { count: value.length }
            : typeof value === 'string' ? { type: 'string', length: value.length }
            : typeof value === 'number' && Number.isFinite(value) ? { type: 'number', value }
            : { type: typeof value }])),
      };
      const diagnostic = ['browser_state', 'browser_capabilities'].includes(definition.name);
      try {
        const value = await runtime.run(async () => {
          meta.target = runtime.url ? redactUrl(runtime.url) : '';
          if (!diagnostic) runtime.touchAgent(definition.name === 'browser_navigate' ? '正在打开 ' + redactUrl(String(args?.url || '')) : ({ browser_eval: '执行脚本', browser_input: '派发输入事件', browser_network: '读取网络记录', browser_screenshot: '截图', browser_computed_style: '读取计算样式' }[definition.name]));
          return execute(args, { ...exec, meta });
        }, { signal: exec.signal, sessionId, agent: !diagnostic });
        const result = { ...value, ...meta, finishedAt: Date.now(), target: runtime.url ? redactUrl(runtime.url) : '' };
        const notes = [];
        const clean = losslessJson(result, definition.name, notes);
        if (!clean || typeof clean !== 'object' || Array.isArray(clean)) throw new BrowserError('INTERNAL', '工具返回值不是对象');
        if (notes.length > 0) clean.sanitized = notes;
        return clean;
      } catch (error) {
        const classified = asBrowserError(error);
        const evidence = { ...meta, finishedAt: Date.now(), target: meta.target || (runtime.url ? redactUrl(runtime.url) : '') };
        classified.details = losslessJson({ ...classified.details, ...evidence }, definition.name + '.details', []);
        classified.message += ' ' + JSON.stringify(evidence);
        runtime.lastError = classified.message;
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
      return { ok: true, ...await runtime.navigate(target, exec.signal) };
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
      return runtime.evaluate(String((args && args.expression) || 'undefined'), true, exec.signal);
    },
  });

  register({
    name: 'browser_screenshot',
    description: '截取内嵌浏览器的当前画面（PNG base64）。',
    parameters: { type: 'object', properties: {} },
    output: { schema: { type: 'object' }, render: (args, value) => {
      const { image, attachment, ...meta } = value;
      return attachment ? [{ type: 'image', attachment }, ...text(meta)] : text({ ...meta, image });
    } },
    async execute(args, exec) {
      const shot = await runtime.screenshot(exec.signal);
      const data = Buffer.from(shot.base64, 'base64');
      let attachment;
      let attachmentError;
      if (typeof attachments?.saveImage === 'function') {
        try { attachment = projectAttachment(await abortable(attachments.saveImage({ data, mediaType: 'image/png', name: `ui-testing-${exec.meta.actionId}.png` }), exec.signal)); }
        catch (error) {
          if (error.code === 'ABORTED') throw error;
          attachmentError = '附件保存失败，使用 base64-fallback';
        }
      }
      return { viewport: shot.viewport, bytes: data.length, image: shot.base64,
        capturedAt: shot.capturedAt, sha256: createHash('sha256').update(data).digest('hex'),
        attachment, attachmentId: attachment ? (attachment.attachmentId || attachment.id) : null,
        imageDelivery: attachment ? 'attachment' : 'base64-fallback', attachmentError };
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
                oneOf: [
                  { type: 'array', items: { type: 'string', enum: ['alt', 'ctrl', 'meta', 'shift'] } },
                  { type: 'integer', minimum: 0, maximum: 15 },
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
      const applied = await runtime.input(args?.events, exec.signal);
      return { ok: true, applied };
    },
  });

  register({
    name: 'browser_network',
    description: '读取内嵌浏览器最近捕获的网络请求（T1 网络抓包，默认不含请求体）。',
    parameters: {
      type: 'object',
      properties: { limit: { type: 'number', description: '最多返回条数，默认 50' } },
    },
    output: { schema: { type: 'object' }, render: (args, value) => text(value) },
    async execute(args) {
      return runtime.traffic(Number(args && args.limit) || 50);
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
      return runtime.computedStyle(String(args && args.selector), Array.isArray(args && args.properties) ? args.properties : undefined, exec.signal);
    },
  });

  register({
    name: 'browser_state',
    description: '读取内嵌浏览器的当前状态：地址、标题、视口、控制权归属。',
    parameters: { type: 'object', properties: {} },
    output: { schema: { type: 'object' }, render: (args, value) => text(value) },
    async execute(args, exec) {
      await runtime.refreshTitle(exec.signal);
      return runtime.state();
    },
  });

  register({
    name: 'browser_capabilities',
    description: '查询 Web T1 工具、运行态、隔离模式及证据限制；不会启动浏览器。',
    parameters: { type: 'object', properties: {} },
    output: { schema: { type: 'object' }, render: (args, value) => text(value) },
    async execute(args, exec) {
      const running = Boolean(runtime.cdp && !runtime.cdp.closed);
      const owner = runtime.state().owner.sessionId;
      const busy = owner && owner !== exec.meta.sessionId;
      const tools = ['navigate', 'eval', 'screenshot', 'input', 'network', 'computed_style', 'state', 'capabilities'];
      return { ok: true,
        runtime: { running, browser: 'chromium', transport: running ? 'ws' : 'unavailable', isolation: 'single-owner-lease', attachments: typeof attachments?.saveImage === 'function' },
        capabilities: [
          ...tools.map((name) => ({ id: 'web.t1.' + name, tool: 'browser_' + name,
            status: busy && !['state', 'capabilities'].includes(name) ? 'unavailable' : 'available',
            ...(busy && !['state', 'capabilities'].includes(name) ? { reason: 'BUSY: browser owned by another session' } : {}),
            constraints: ['page tools lazily start Chromium; startup may fail', 'single owner lease; shared page with panel'] })),
          ...['t2.structured-dom', 't3.static-vision', 't4.dynamic-vision', 't1.http-request'].map((id) => ({ id: 'web.' + id, status: 'unsupported', reason: 'Not implemented' })),
        ],
        limits: { viewport: runtime.viewport, networkEntries: NETWORK_LIMIT, screenshot: typeof attachments?.saveImage === 'function' ? 'attachment' : 'base64-fallback', leaseIdleMs: AGENT_HOLD_MS, navigation: 'Document URLs and DNS checked; subresources are not a network sandbox' },
      };
    },
  });
}
