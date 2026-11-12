window.__ModuleLoader__.load({
  id: 'dsh-agent-team-ui-testing',
  factory(require) {
    const React = require('react');
    const h = React.createElement;
    // Portal target for the diagnostics overlay: the DSH settings modal is its own layer, so the
    // overlay has to live at <body> level (with a high z-index) to win the stacking order.
    let reactDom = null;
    try { reactDom = require('react-dom'); } catch { reactDom = null; }

    const ID = 'ui-testing-browser';
    /** 面板构建标识：刷新后用它确认浏览器里跑的是哪一份 client.js（排查「改了没生效」）。 */
    const CLIENT_BUILD = '2026-11-11T18:50+08:00·address-history-per-workspace';
    const KIND = 'debug-view';
    const TITLE = '调试视图';
    /** 可选运行环境；本期只有 Web 视图可用，其余置灰。 */
    const ENVIRONMENTS = [
      { id: 'web', label: 'Web 视图', short: 'Web', ready: true },
      { id: 'windows', label: 'Windows 视图', short: 'Windows', ready: false },
      { id: 'android', label: 'Android 视图', short: 'Android', ready: false },
      { id: 'linux', label: 'Linux 视图', short: 'Linux', ready: false },
      { id: 'macos', label: 'macOS 视图', short: 'macOS', ready: false },
      { id: 'tui', label: 'TUI 视图', short: 'TUI', ready: false },
      { id: 'harmonyos', label: 'HarmonyOS 视图', short: 'HarmonyOS', ready: false },
      { id: 'game', label: '游戏视图', short: '游戏', ready: false },
      { id: 'three-d', label: '3D 视图', short: '3D', ready: false },
      { id: 'miniprogram', label: '小程序视图', short: '小程序', ready: false },
    ];
    /** 与 Host 半边的运行时通信（同源，走应用自身的鉴权）。 */
    const HOST_BASE = '/plugins/ui-testing';
    const SCOPE_VERSION = '1';
    /**
     * 根插件上下文（apply 时捕获）。面板组件定义在模块作用域，拿不到 apply 的闭包，因此通过
     * 这个引用按需读取 DSH 服务（例如 conversation.input.shell 的聊天框追加）。服务缺失/读取
     * 抛错时一律按“不可用”降级，不影响面板。
     */
    let pluginContext = null;

    /**
     * Immutable request identity for one panel generation.
     * `kind` is `session` (explicit Session) or `recent` (main panel without a captured Session).
     * A `recent` identity is pinned to one Host runtime by `binding` (the Host's ui.runtimeId), so
     * later state/input/WS requests cannot drift to another workspace when `recent` is re-resolved.
     */
    function scopeSnapshot(kind, sessionId, binding, legacy) {
      return Object.freeze({
        version: SCOPE_VERSION,
        kind: kind === 'session' ? 'session' : 'recent',
        sessionId: kind === 'session' ? String(sessionId || '') : '',
        binding: binding ? String(binding) : '',
        legacy: legacy === true,
      });
    }

    /**
     * Address history: a bounded LIFO stack of the last visited page addresses.
     *
     * The stack is panel-local (localStorage, shared by the panels of this GUI origin) and keeps
     * the newest entry at index 0. Only real HTTP(S) addresses are stored: `about:blank`, empty
     * drafts and app-internal addresses never enter the list. Revisiting a URL moves it back to
     * the front instead of duplicating it. These are pure helpers so the contract test can run the
     * real implementations rather than a copy.
     */
    const ADDRESS_HISTORY_LIMIT = 7;
    const ADDRESS_HISTORY_KEY = 'dsh-agent-team-ui-testing:address-history:v2';
    /** One bucket per workspace scope: two workspaces never read each other's history. */
    function addressHistoryStorageKey(scopeId) {
      const clean = typeof scopeId === 'string' ? scopeId.trim().slice(0, 96).replace(/[^A-Za-z0-9_.:-]/gu, '') : '';
      return ADDRESS_HISTORY_KEY + ':' + (clean || 'unscoped');
    }
    function addressHistoryNormalize(list, limit = ADDRESS_HISTORY_LIMIT) {
      const out = [];
      for (const item of Array.isArray(list) ? list : []) {
        const value = typeof item === 'string' ? item.trim() : '';
        if (!/^https?:\/\//i.test(value) || out.includes(value)) continue;
        out.push(value);
        if (out.length >= limit) break;
      }
      return out;
    }
    function addressHistoryPush(list, raw, limit = ADDRESS_HISTORY_LIMIT) {
      const value = typeof raw === 'string' ? raw.trim() : '';
      const current = addressHistoryNormalize(list, limit);
      if (!/^https?:\/\//i.test(value)) return current;
      return addressHistoryNormalize([value].concat(current), limit);
    }
    function addressHistoryLabel(raw) {
      const value = String(raw || '');
      try {
        const parsed = new URL(value);
        const path = (parsed.pathname || '/') + (parsed.search || '');
        return String(parsed.host || value) + (path === '/' ? '' : path);
      } catch { return value; }
    }
    /** Local storage accessor: a privacy mode that throws must not break the address bar. */
    function addressHistoryStorage() {
      try { return typeof window !== 'undefined' && window.localStorage ? window.localStorage : null; } catch { return null; }
    }
    function addressHistoryRead(storage, scopeId, limit = ADDRESS_HISTORY_LIMIT) {
      try {
        if (!storage) return [];
        const key = addressHistoryStorageKey(scopeId);
        return addressHistoryNormalize(JSON.parse(storage.getItem(key) || '[]'), limit);
      } catch { return []; }
    }
    function addressHistoryWrite(storage, scopeId, list) {
      try {
        if (!storage) return false;
        storage.setItem(addressHistoryStorageKey(scopeId), JSON.stringify(addressHistoryNormalize(list)));
        return true;
      } catch { return false; }
    }

    /**
     * Human-foreground claims (P0-D `browser_annotation`, docs/viewport-control.md).
     *
     * A mount claims "I am displaying my selected tab and I am visible"; the Host turns that into a
     * ~1.5s freshness window, which is what lets the Agent draw an annotation a human can actually
     * see. It is a *display* fact only: no claim means the Agent's `draw` is refused, never that the
     * page is absent. Several panels may legitimately display at once (main column + side seat), so
     * this is a set, not a single flag.
     */
    const guiForegroundClaims = new Set();
    let guiForegroundSerial = 0;
    function newGuiForegroundClaim() {
      guiForegroundSerial += 1;
      return 'fg:' + guiForegroundSerial;
    }
    /** Visible claims *and* a GUI page that is not backgrounded — otherwise nothing is displayed. */
    function guiForegroundActive() {
      if (guiForegroundClaims.size === 0) return false;
      if (typeof document !== 'undefined' && document.visibilityState === 'hidden') return false;
      return true;
    }

    function scopeHeaders(scope) {
      if (!scope) return {};
      const headers = { 'X-UI-Testing-Scope-Version': SCOPE_VERSION };
      if (scope.kind === 'session' && scope.sessionId) {
        headers['X-UI-Testing-Session-Id'] = scope.sessionId;
        // P0-E: the panel renders its own selected tab. Without this hint the Host resolves a
        // session scope through that Agent session's selectedTab, so the Agent switching tabs would
        // silently redirect the preview while the strip stays where the user left it.
        headers['X-UI-Testing-Scope-Tab'] = 'primary';
      } else if (scope.binding) {
        headers['X-UI-Testing-Scope-Binding'] = scope.binding;
      } else {
        headers['X-UI-Testing-Scope'] = 'recent';
      }
      // "This runtime is my selected tab and I am visible" (docs/viewport-control.md): only sent
      // while this mount really displays it, so the Host's window expires when the user switches
      // tabs, closes the panel or backgrounds the GUI.
      if (guiForegroundActive()) headers['X-UI-Testing-Gui-Foreground'] = '1';
      return headers;
    }

    async function callHost(op, body, options) {
      const scope = options && options.scope;
      const signal = options && options.signal;
      const response = await fetch(HOST_BASE + '/' + op, {
        method: 'POST',
        headers: Object.assign({ 'content-type': 'application/json' }, scopeHeaders(scope)),
        credentials: 'same-origin',
        body: JSON.stringify(body || {}),
        signal,
      });
      const payload = await response.json().catch(() => ({}));
      if (!response.ok || payload.ok === false) {
        const error = new Error(payload.error || ('运行时请求失败：' + response.status));
        error.code = payload.code;
        // The safe numeric view (if any) lets a revision conflict adopt the real state.
        error.payload = payload;
        throw error;
      }
      return payload;
    }

    /** GET helper: every read carries the same immutable scope snapshot as writes. */
    async function getHost(path, scope, signal) {
      const response = await fetch(HOST_BASE + path, { credentials: 'same-origin', headers: scopeHeaders(scope), signal, cache: 'no-store' });
      const payload = await response.json().catch(() => ({}));
      if (!response.ok || payload.ok === false) {
        const error = new Error(payload.error || ('运行时请求失败：' + response.status));
        error.code = payload.code;
        throw error;
      }
      return payload;
    }

    /* ---- Host config transport (M4) ------------------------------------------------------
     * The Host revision is the only truth for the settings page and the panel environment
     * selector. Every helper resolves with the Host payload or throws an Error carrying `.code`
     * (`CONFIG_CONFLICT`, `CONFIG_UNAVAILABLE`, ...); callers render the failure and never fake a
     * saved state. `scope` is `null` on the settings page (legacy/default, no scope headers).
     * ------------------------------------------------------------------------------------- */
    /**
     * Upper bound for one config read, covering **both** the response headers and the JSON body.
     * Without it a connection that never finishes would keep the poll's in-flight marker set
     * forever: no new request, no stale marker, a page that looks frozen (M5).
     */
    const HOST_CONFIG_TIMEOUT_MS = 10000;

    async function requestHostConfig(method, path, body, options) {
      const scope = options && options.scope;
      const outerSignal = options && options.signal;
      const timeoutMs = options && Number.isFinite(options.timeoutMs) && options.timeoutMs > 0
        ? Number(options.timeoutMs)
        : 0;
      const headers = Object.assign({}, scopeHeaders(scope));
      // One controller per request: it carries its own deadline, and the caller's lifecycle signal
      // (unmount) is forwarded into it so a hanging read is aborted on both paths.
      const controller = timeoutMs && typeof AbortController === 'function' ? new AbortController() : null;
      let timedOut = false;
      let timer = null;
      const onOuterAbort = () => { if (controller) controller.abort(); };
      if (controller) {
        if (outerSignal) {
          if (outerSignal.aborted) controller.abort();
          else outerSignal.addEventListener('abort', onOuterAbort, { once: true });
        }
        timer = setTimeout(() => { timedOut = true; controller.abort(); }, timeoutMs);
      }
      const init = {
        method,
        credentials: 'same-origin',
        headers,
        signal: controller ? controller.signal : outerSignal,
        cache: 'no-store',
      };
      if (body !== undefined) {
        headers['content-type'] = 'application/json';
        init.body = JSON.stringify(body);
      }
      try {
        const response = await fetch(HOST_BASE + path, init);
        // `response.json()` is a second, separate wait: keep it inside the same deadline.
        const payload = await response.json().catch(() => ({}));
        if (!response.ok || payload.ok === false) {
          const error = new Error(payload.error || ('配置请求失败：' + response.status));
          error.code = payload.code || (response.status === 404 ? 'CONFIG_UNAVAILABLE' : 'CONFIG_REQUEST_FAILED');
          error.status = response.status;
          error.payload = payload;
          throw error;
        }
        return payload;
      } catch (error) {
        if (timedOut) {
          // 超时是一个可渲染的失败（→ stale），而不是静默的悬挂。
          const timeoutError = new Error('配置请求超时（' + timeoutMs + 'ms）');
          timeoutError.code = 'CONFIG_TIMEOUT';
          timeoutError.timeout = true;
          throw timeoutError;
        }
        throw error;
      } finally {
        if (timer !== null) clearTimeout(timer);
        if (outerSignal && controller) outerSignal.removeEventListener('abort', onOuterAbort);
      }
    }

    /** GET /config — `view` is `global` (settings page) or `session` (panel). */
    function getHostConfig(scope, view, signal, timeoutMs) {
      return requestHostConfig(
        'GET',
        '/config?view=' + encodeURIComponent(view || 'global'),
        undefined,
        { scope, signal, timeoutMs: timeoutMs || HOST_CONFIG_TIMEOUT_MS },
      );
    }

    /** PUT /config — CAS write; resolves with the Host revision, never assumes success. */
    function putHostConfig(patch, expectedRevision, scope) {
      return requestHostConfig('PUT', '/config', { expectedRevision, scope: 'global', patch }, { scope });
    }

    /** POST /config/select — session environment selection for this panel scope. */
    function selectHostEnvironment(environment, expectedRevision, scope) {
      return requestHostConfig('POST', '/config/select', { scope: 'session', environment, expectedRevision }, { scope });
    }

    /** The Host's cold/recent binding (ui.runtimeId) for a scope-bearing response. */
    function runtimeIdOf(payload) {
      if (!payload || typeof payload !== 'object') return '';
      const state = payload.state && typeof payload.state === 'object' ? payload.state : payload;
      const ui = state.ui && typeof state.ui === 'object' ? state.ui : null;
      const candidates = [
        payload.binding, state.binding,
        payload.scope && payload.scope.runtimeId, state.scope && state.scope.runtimeId,
        payload.scope && payload.scope.binding, state.scope && state.scope.binding,
        ui && ui.runtimeId, state.runtimeId, payload.runtimeId,
      ];
      for (const value of candidates) if (value) return String(value);
      return '';
    }

    /** True when the Host answered with workspace-scope evidence (new protocol). */
    function hasScopeEvidence(payload) {
      if (!payload || typeof payload !== 'object') return false;
      const state = payload.state && typeof payload.state === 'object' ? payload.state : payload;
      const ui = state.ui && typeof state.ui === 'object' ? state.ui : null;
      return Boolean(payload.scope || state.scope || (ui && ui.scope) || payload.scopeId || state.scopeId);
    }

    let legacyHostWarned = false;
    function warnLegacyHost() {
      if (legacyHostWarned) return;
      legacyHostWarned = true;
      console.warn('ui-testing: Host does not expose workspace scope; the panel is using the shared legacy browser (no workspace isolation).');
    }

    /** True when this GUI is served from the user's own loopback (v1 direct-CDP limitation). */
    function guiHostIsLoopback() {
      try {
        const host = String(window.location.hostname || '').toLowerCase();
        return host === '127.0.0.1' || host === 'localhost' || host === '::1' || host === '[::1]';
      } catch (error) {
        return false;
      }
    }

    /**
     * Strict validation of the Host-provided DevTools popup URL (docs/internal/devtools-popup.md §5).
     *
     * The URL is the only thing this panel navigates an external window to, so it accepts exactly:
     * http, 127.0.0.1, a valid explicit port, `/devtools/inspector.html`, one `ws` query whose
     * decoded value is the same host:port and `/devtools/page/<id>`. Credentials, fragments,
     * extra parameters and any other scheme/host are refused (null) instead of normalised.
     */
    function validateDevtoolsUrl(raw) {
      if (typeof raw !== 'string' || !raw || raw.length > 2048) return null;
      let url;
      try { url = new URL(raw); } catch (error) { return null; }
      if (url.protocol !== 'http:') return null;
      if (url.username || url.password || url.hash) return null;
      if (url.hostname !== '127.0.0.1') return null;
      const port = Number(url.port);
      if (!Number.isInteger(port) || port <= 0 || port > 65535) return null;
      if (url.pathname !== '/devtools/inspector.html') return null;
      const keys = [...url.searchParams.keys()];
      if (keys.length !== 1 || keys[0] !== 'ws') return null;
      const ws = url.searchParams.get('ws') || '';
      // Decoded once by URLSearchParams above; a second scheme/authority/query is refused.
      if (!ws || ws.includes('://') || /[?#@\\\s]/.test(ws)) return null;
      let target;
      try { target = new URL('ws://' + ws); } catch (error) { return null; }
      if (target.hostname !== '127.0.0.1') return null;
      if (Number(target.port) !== port) return null;
      if (!/^\/devtools\/page\/[A-Za-z0-9_-]{1,128}$/.test(target.pathname)) return null;
      if (target.search || target.hash || target.username || target.password) return null;
      return url.href;
    }

    /** 尺寸条左侧的分辨率预设。 */
    const PRESETS = [
      { id: 'wide', label: '宽屏', w: 1920, h: 1080 },
      { id: 'landscape', label: '横屏', w: 1024, h: 768 },
      { id: 'tablet', label: '平板', w: 768, h: 1024 },
      { id: 'phone', label: '手机', w: 393, h: 852 },
    ];
    /**
     * 用户 2026-11-03 第 3 条：默认分辨率按运行环境确定。只引用现有 PRESETS，不引入新尺寸；
     * 非 ready 环境只占位（选项 disabled，handler 仍判 ready）。
     */
    const ENV_DEFAULTS = Object.freeze({
      web: { preset: 'landscape', fit: true },
      windows: { preset: 'landscape', fit: true },
      linux: { preset: 'landscape', fit: true },
      macos: { preset: 'landscape', fit: true },
      tui: { preset: 'landscape', fit: true },
      android: { preset: 'phone', fit: true },
      harmonyos: { preset: 'phone', fit: true },
      game: { preset: 'wide', fit: true },
      'three-d': { preset: 'wide', fit: true },
      miniprogram: { preset: 'phone', fit: true },
    });
    function envDefaultSize(id) {
      const def = ENV_DEFAULTS[id] || ENV_DEFAULTS.web;
      const preset = PRESETS.find((item) => item.id === def.preset) || PRESETS[1];
      return { width: preset.w, height: preset.h, fit: def.fit !== false };
    }
    /** 左下角控制权状态：空闲 / 人类接管 / Agent 操作中。 */
    const MODE_LABEL = { idle: '空闲', human: '人类接管', agent: 'Agent 操作中' };

    /**
     * 视口共享状态（Host `ui.view`）的边界。`scalePercent` 是本面板的手动范围；
     * Host 的 `view.scale` 是 0.1–2.0 的共享比例（Agent 截图默认密度），不启用页面缩放/DPR。
     */
    const VIEW_LIMITS = {
      width: [200, 4096],
      height: [200, 4096],
      scroll: [0, 10000000],
      // P0-C v2 canvas origin C (docs/viewport-control.md): viewport top-left on the document
      // canvas, allowed to be negative or beyond the content box.
      canvas: [-10000000, 10000000],
      scalePercent: [10, 200],
    };
    /**
     * Host screenshot/T3 blank colour: evidence semantics, always #ffffff
     * (docs/viewport-control.md). The panel must NOT use it for display.
     */
    const CANVAS_BLANK_EVIDENCE = '#ffffff';
    /**
     * Panel-only blank: a dark checkerboard (user request 2026-11-02) so composited whitespace is
     * visible against white pages. Fixed host CSS pixels, independent of view.scale. This is a
     * local display style; the evidence/Host blank stays #ffffff.
     */
    const CANVAS_CHECKER = Object.freeze({ dark: '#2b2b2b', light: '#3f3f3f', size: 14 });
    /** 尺寸栏数值滚轮：向上增、向下减；Alt 优先于 Shift。 */
    const WHEEL_STEPS = {
      width: { normal: 10, shift: 100, alt: 1 },
      height: { normal: 10, shift: 100, alt: 1 },
      x: { normal: 10, shift: 100, alt: 1 },
      y: { normal: 10, shift: 100, alt: 1 },
      scale: { normal: 5, shift: 10, alt: 1 },
    };
    /** 本地编辑合并窗口与尺寸变更后的输入暂停上限（best-effort，帧协议不变）。 */
    const VIEW_DEBOUNCE_MS = 120;
    const GEOMETRY_WAIT_MS = 250;
    const POINTER_EPSILON = 0.001;
    const FRAME_WHEEL_LINE_CSS_PX = 16;
    /* ---- 选元素发送到聊天框：纯函数与常量（无 DOM 依赖，可按 marker 提取做单测） ---------- */
    const PICK_HOVER_MS = 80;
    const PICK_WHEEL_DEBOUNCE_MS = 180;
    const PICK_STATUS_MS = 4200;
    function pickCollapseText(value) {
      return String(value === undefined || value === null ? '' : value).replace(/\s+/g, ' ').trim();
    }
    function pickTagName(element) {
      const raw = pickCollapseText(element && element.tag).toLowerCase().replace(/[^a-z0-9_-]/g, '');
      return raw || 'element';
    }
    function pickClassList(element) {
      const raw = element && element.classes;
      const list = Array.isArray(raw) ? raw : String(raw === undefined || raw === null ? '' : raw).split(/\s+/);
      return list.map((value) => pickCollapseText(value))
        .filter((value) => /^[A-Za-z_][\w-]*$/.test(value)).slice(0, 3);
    }
    function pickId(element) {
      return pickCollapseText(element && element.id).replace(/[^\w-]/g, '');
    }
    /** `<tag#id.class>` 兜底：Host 没给 outerHTML/selector 时仍能给出稳定标识。 */
    function pickCompoundSelector(element) {
      const id = pickId(element);
      const classes = pickClassList(element);
      return pickTagName(element) + (id ? '#' + id : '') + classes.map((name) => '.' + name).join('');
    }
    /** 左上角小标签：tag#id 或 tag.class。 */
    function pickTagLabel(element) {
      const id = pickId(element);
      if (id) return pickTagName(element) + '#' + id;
      const classes = pickClassList(element);
      return pickTagName(element) + (classes.length ? '.' + classes[0] : '');
    }
    function pickNumberText(value) {
      const number = Number(value);
      if (!Number.isFinite(number)) return '0';
      return String(Math.round(number * 100) / 100);
    }
    /* ---- 元素引用（@ chip）：聊天框显示紧凑引用，模型收到完整块 ---------------------------- */
    const ELEMENT_REF_SOURCE = 'ui-element';
    const ELEMENT_REF_VERSION = 1;
    const ELEMENT_REF_LABEL_MAX = 40;
    const ELEMENT_REF_RECENT_MAX = 12;
    /** 最近选取的元素引用，按 Agent session 分组（@ 菜单候选来源；不跨会话混用）。 */
    const elementRefs = { seq: 0, bySession: new Map(), lastSessionId: null, sourceRegistered: false };

    function elementRefBase64Url(bytes) {
      let binary = '';
      for (const byte of bytes) binary += String.fromCharCode(byte);
      return btoa(binary).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/u, '');
    }
    function elementRefEncode(payload) {
      const bytes = new TextEncoder().encode(JSON.stringify(payload));
      return 'v' + ELEMENT_REF_VERSION + '.' + elementRefBase64Url(bytes);
    }
    function elementRefDecode(ref) {
      const match = /^v(\d+)\.([A-Za-z0-9_-]+)$/u.exec(pickCollapseText(ref));
      if (!match || Number(match[1]) !== ELEMENT_REF_VERSION) return null;
      try {
        const padded = match[2].replace(/-/g, '+').replace(/_/g, '/');
        const binary = atob(padded + '='.repeat((4 - (padded.length % 4)) % 4));
        const bytes = new Uint8Array(binary.length);
        for (let index = 0; index < binary.length; index += 1) bytes[index] = binary.charCodeAt(index);
        const parsed = JSON.parse(new TextDecoder().decode(bytes));
        return parsed && typeof parsed === 'object' ? parsed : null;
      } catch {
        return null;
      }
    }
    /** Host detail → 自包含引用载荷（chip 标签、剪贴板文本、模型文本共用同一份事实）。 */
    function pickElementPayload(element, fallbackUrl) {
      const source = element && typeof element === 'object' ? element : {};
      const rect = source.rect && typeof source.rect === 'object' ? source.rect : {};
      const page = source.page && typeof source.page === 'object' ? source.page : {};
      const finite = (value) => (Number.isFinite(Number(value)) ? Number(value) : null);
      return {
        v: ELEMENT_REF_VERSION,
        tag: pickTagName(source),
        id: pickId(source) || null,
        classes: pickClassList(source),
        selector: pickCollapseText(source.selector) || null,
        selectorQuality: source.selectorQuality === 'unique' || source.selectorQuality === 'degraded'
          || source.selectorQuality === 'none' ? source.selectorQuality : null,
        role: pickCollapseText(source.role) || null,
        name: pickCollapseText(source.name) || null,
        rect: { x: finite(rect.x) || 0, y: finite(rect.y) || 0, width: finite(rect.width) || 0, height: finite(rect.height) || 0 },
        page: {
          url: pickCollapseText(page.url) || pickCollapseText(fallbackUrl) || null,
          title: pickCollapseText(page.title) || null,
        },
        frameId: source.frameId === undefined || source.frameId === null ? null : String(source.frameId),
        // 嵌套 frame 命中：Host 只在子 frame 上给 frame，selector 属于该 frame 的文档。
        frame: source.frame && source.frame.main === false
          ? {
            id: pickCollapseText(source.frame.id) || null,
            url: pickCollapseText(source.frame.url) || null,
          }
          : null,
        outerHTML: pickCollapseText(source.outerHTML) || null,
        outerHTMLTruncated: source.outerHTMLTruncated === true,
        outerHTMLLength: finite(source.outerHTMLLength),
        text: pickCollapseText(source.text) || null,
        textTruncated: source.textTruncated === true,
        textLength: finite(source.textLength),
      };
    }
    /** 定位标识：degraded selector 不作为引用名（它不是唯一定位器）。 */
    function pickElementLocator(payload) {
      if (payload.selector && payload.selectorQuality !== 'degraded') return payload.selector;
      const compound = payload.tag + (payload.id ? '#' + payload.id : '')
        + (payload.classes || []).map((name) => '.' + name).join('');
      return compound || payload.tag || 'element';
    }
    /** 引用插入描述（@ 菜单 onPick 与面板插入共用；clipboard 与模型文本分离）。 */
    function elementRefInsertFor(ref) {
      const payload = elementRefDecode(ref);
      if (!payload) return null;
      return {
        source: ELEMENT_REF_SOURCE,
        ref,
        label: pickElementChipLabel(payload),
        clipboardText: pickElementClipboardText(payload),
      };
    }
    /** chip 标签：紧凑、可读，长 selector 截断到 40 码点。 */
    function pickElementChipLabel(payload) {
      const text = '元素 ' + pickElementLocator(payload);
      const chars = Array.from(text);
      return chars.length > ELEMENT_REF_LABEL_MAX ? chars.slice(0, ELEMENT_REF_LABEL_MAX - 1).join('') + '…' : text;
    }
    function pickElementClipboardText(payload) {
      return '@' + pickElementChipLabel(payload);
    }
    /** 模型文本：完整块；截断与 degraded selector 必须显式标注，不能静默省略。 */
    function pickElementModelText(payload) {
      const summary = payload.outerHTML ? payload.outerHTML : '<' + pickElementLocator(payload) + '>';
      const selector = payload.selector || pickElementLocator(payload);
      const lines = ['[调试视图元素] ' + summary];
      lines.push('selector: ' + selector
        + (payload.selectorQuality === 'degraded' ? '（degraded：非唯一定位，仅作线索）' : ''));
      if (payload.role || payload.name) lines.push('role: ' + (payload.role || '') + ' · name: ' + (payload.name || ''));
      const rect = payload.rect || {};
      lines.push('rect(文档坐标): x=' + pickNumberText(rect.x) + ', y=' + pickNumberText(rect.y)
        + ', ' + pickNumberText(rect.width) + '×' + pickNumberText(rect.height));
      if (payload.page && payload.page.url) lines.push('page: ' + payload.page.url);
      // 嵌套 frame 的 selector 只在那个 frame 的文档里有效：不写出来，模型会当成主文档选择器。
      if (payload.frame && payload.frame.url) lines.push('frame: ' + payload.frame.url + '（selector 在该 frame 文档内有效）');
      if (payload.outerHTMLTruncated) {
        const shown = Math.max(0, Array.from(payload.outerHTML || '').length - 1);
        const total = payload.outerHTMLLength === null ? '?' : String(payload.outerHTMLLength);
        lines.push('outerHTML: 截断 ' + shown + '/' + total + ' 码点（末尾 …，完整文本未取得）');
      }
      return lines.join('\n');
    }
    function elementRefRemember(sessionId, payload) {
      const key = String(sessionId || '');
      if (!key) return null;
      const ref = elementRefEncode(payload);
      const locator = pickElementLocator(payload);
      const item = {
        ref,
        locator,
        label: pickElementChipLabel(payload),
        description: [
          payload.tag,
          payload.role || payload.name || '',
          pickNumberText(payload.rect.width) + '×' + pickNumberText(payload.rect.height),
          payload.page && payload.page.url ? payload.page.url : '',
        ].filter(Boolean).join(' · '),
        search: [locator, payload.tag, payload.id, payload.name, payload.page && payload.page.url]
          .filter(Boolean).join(' ').toLowerCase(),
      };
      const list = elementRefs.bySession.get(key) || [];
      elementRefs.bySession.set(key, [item, ...list.filter((entry) => entry.ref !== ref)].slice(0, ELEMENT_REF_RECENT_MAX));
      elementRefs.seq += 1;
      return item;
    }
    function elementRefCandidates(sessionId, query) {
      const needle = String(query || '').trim().toLowerCase();
      const list = elementRefs.bySession.get(String(sessionId || '')) || [];
      return list
        .filter((item) => !needle || item.search.includes(needle))
        .map((item) => ({ name: item.locator, label: item.label, description: item.description, value: item.ref, hint: '插入元素引用' }));
    }
    /**
     * 用 `@` 引用 chip 把元素加入聊天框：chip 只显示紧凑标签，模型文本由 codec.serialize 提供。
     * 插入是公开的 `SessionInput.insertReference`（span CAS 到当前 draftRev）；任何一步不可用都
     * 返回 { ok:false, reason }，由调用方降级为纯文本块，绝不静默丢失元素或伪造成功。
     */
    function pickInsertElementChip(sessionId, payload) {
      const sid = String(sessionId || '');
      if (!sid) return { ok: false, reason: 'no-session' };
      // Test-only seam (both globals must be enabled by the acceptance page): exercise the
      // plain-text fallback without having to fake a busy composer in a real session.
      if (typeof window !== 'undefined' && window.__UTB_TEST_HOOKS__ === true
        && window.__UTB_TEST_FORCE_TEXT_APPEND__ === true) {
        return { ok: false, reason: 'forced' };
      }
      const ctx = pluginContext;
      if (!ctx || typeof ctx.get !== 'function') return { ok: false, reason: 'unavailable' };
      let sessions = null;
      let conversation = null;
      try {
        sessions = ctx.get('sessions');
        conversation = ctx.get('conversation');
      } catch {
        return { ok: false, reason: 'unavailable' };
      }
      const input = conversation && conversation.input;
      if (!input || typeof input.for !== 'function' || !sessions || typeof sessions.binding !== 'function') {
        return { ok: false, reason: 'unavailable' };
      }
      let binding = null;
      try { binding = sessions.binding(sid); } catch { binding = null; }
      if (!binding) return { ok: false, reason: 'not-retained' };
      let face = null;
      try { face = input.for(binding.ctx); } catch { face = null; }
      if (!face || typeof face.insertReference !== 'function') return { ok: false, reason: 'unavailable' };
      let state = null;
      try { state = face.state && typeof face.state.getSnapshot === 'function' ? face.state.getSnapshot() : null; } catch { state = null; }
      if (!state || typeof state.draft !== 'string' || !Number.isInteger(state.draftRev)) {
        return { ok: false, reason: 'unavailable' };
      }
      if (state.phase !== 'plain' && state.phase !== 'claimed') return { ok: false, reason: 'busy' };
      elementRefs.lastSessionId = sid;
      const ref = elementRefEncode(payload);
      // `InputState.draft` is the clipboard projection: every chip expands to its clipboardText
      // there, while the editor's detect projection holds ONE placeholder per chip. Insert at the
      // END of the detect projection so a draft that already contains @ references still maps.
      const occurrences = Array.isArray(state.occurrences) ? state.occurrences : [];
      const placeholderDelta = occurrences.reduce((sum, occurrence) => {
        const length = Number(occurrence && occurrence.length);
        return sum + (Number.isFinite(length) && length > 1 ? length - 1 : 0);
      }, 0);
      const detectEnd = Math.max(0, state.draft.length - placeholderDelta);
      const span = { start: detectEnd, end: detectEnd, draftRev: state.draftRev };
      let applied = false;
      try {
        applied = face.insertReference(elementRefInsertFor(ref), span);
      } catch {
        applied = false;
      }
      if (!applied) return { ok: false, reason: 'blocked' };
      try { if (typeof face.focus === 'function') face.focus(); } catch { /* focus is best-effort */ }
      if (typeof window !== 'undefined' && window.__UTB_TEST_HOOKS__ === true) {
        const insert = elementRefInsertFor(ref);
        window.__UTB_ELEMENT_REF_LAST__ = {
          ref,
          label: pickElementChipLabel(payload),
          clipboardText: pickElementClipboardText(payload),
          modelText: pickElementModelText(payload),
          payload,
        };
        // Same code paths the @ menu source uses (candidates / onPick / codec.serialize).
        window.__UTB_ELEMENT_SOURCE_HOOK__ = {
          registered: elementRefs.sourceRegistered,
          name: ELEMENT_REF_SOURCE,
          candidates: (query) => elementRefCandidates(elementRefs.lastSessionId, query),
          insertFor: (ref) => elementRefInsertFor(ref),
          serialize: (ref) => {
            const decoded = elementRefDecode(ref);
            return decoded ? pickElementModelText(decoded) : null;
          },
          lastSessionId: elementRefs.lastSessionId,
          insertShape: insert ? { source: insert.source, label: insert.label, clipboardText: insert.clipboardText } : null,
          textRule: { registered: elementTextRuleState.registered, slotRegistered: elementTextRuleState.slotRegistered },
          matchText: (text, from) => {
            const match = elementTextBlockMatch(text, from);
            return match ? { id: match.id, start: match.start, end: match.end, data: match.data } : null;
          },
        };
      }
      return { ok: true };
    }
    /**
     * 注册 `@` 触发来源（“最近选取的元素”候选）。宿主没有 inputTriggers 服务时静默跳过——
     * chip 插入仍走 pickInsertElementChip，只是没有 `@` 菜单候选。
     */
    function registerElementReferenceSource(ctx) {
      if (!ctx) return false;
      let registered = false;
      const install = (host) => {
        if (registered || !host) return registered;
        let triggers = null;
        try { triggers = typeof host.get === 'function' ? host.get('inputTriggers') : null; } catch { triggers = null; }
        if (!triggers || typeof triggers.registerSource !== 'function') return false;
        const source = {
          trigger: '@',
          name: ELEMENT_REF_SOURCE,
          showGroupTitle: false,
          order: -1,
          async candidates(session, req) {
            return elementRefCandidates(session && session.sessionId, req && req.query);
          },
          onPick(pick) {
            const insert = elementRefInsertFor(pickCollapseText(pick && pick.candidate && pick.candidate.value));
            return insert ? { insert } : undefined;
          },
          codec: {
            clipboardText(ref) {
              const payload = elementRefDecode(ref);
              return payload ? pickElementClipboardText(payload) : ref;
            },
            async serialize(ref) {
              const payload = elementRefDecode(ref);
              if (!payload) throw new Error('ui-testing: element reference payload is not decodable');
              return pickElementModelText(payload);
            },
          },
          openReference() {
            try {
              const layout = typeof host.get === 'function' ? host.get('layout') : null;
              if (layout && typeof layout.selectPanel === 'function') {
                layout.selectPanel(ID);
                return true;
              }
            } catch { /* fall through to "not handled" */ }
            return false;
          },
        };
        try {
          const dispose = triggers.registerSource(source);
          registered = true;
          elementRefs.sourceRegistered = true;
          if (typeof ctx.effect === 'function') ctx.effect(() => dispose, 'ui-testing: @ element reference');
          else if (typeof host.effect === 'function') host.effect(() => dispose, 'ui-testing: @ element reference');
          return true;
        } catch {
          return false;
        }
      };
      // The trigger service may settle after this plugin's apply(): declare the dependency so the
      // registration runs when it exists, and still try immediately for hosts that already have it.
      if (typeof ctx.inject === 'function') {
        try { ctx.inject(['inputTriggers'], (sub) => { install(sub); }); } catch { /* immediate install below */ }
      }
      return install(ctx);
    }

    /* ---- 聊天记录里的元素块：折叠为同样的 @ 元素引用 chip（显示 ≠ 原始文本） ------------- */
    const ELEMENT_TEXT_RULE_ID = 'ui-element';
    const ELEMENT_TEXT_BLOCK_PREFIX = '[调试视图元素] ';
    const ELEMENT_TEXT_BLOCK_LINE = /^(?:selector|role|rect\(文档坐标\)|page|outerHTML):/u;
    const elementTextRuleState = { registered: false, slotRegistered: false };

    /**
     * 在用户消息原文里找一段 `[调试视图元素] …` 块（不跨非块行），返回 JSON 安全节点。
     * 模型侧文本不变；这里只决定 transcript 的显示。
     */
    function elementTextBlockMatch(text, from) {
      const source = String(text == null ? '' : text);
      const start = source.indexOf(ELEMENT_TEXT_BLOCK_PREFIX, Math.max(0, Number(from) || 0));
      if (start < 0) return undefined;
      let cursor = start;
      let end = start;
      let lastLineStart = start;
      const lines = [];
      for (;;) {
        const newline = source.indexOf('\n', cursor);
        const lineEnd = newline === -1 ? source.length : newline;
        const line = source.slice(cursor, lineEnd);
        if (lines.length > 0 && !ELEMENT_TEXT_BLOCK_LINE.test(line)) break;
        lines.push(line);
        lastLineStart = cursor;
        end = lineEnd;
        if (newline === -1) break;
        cursor = newline + 1;
      }
      if (end <= start) return undefined;
      const lastLine = lines[lines.length - 1] || '';
      // A chip is serialized as block text and any user text typed after the chip lands on the
      // LAST line (the insert rule adds one trailing space). Stop at the canonical end marker so
      // only the reference is folded and the caller's own sentence stays outside the chip.
      if (lastLine.startsWith('outerHTML: ')) {
        const marker = /^outerHTML: 截断 \d+\/\d+ 码点（末尾 …，完整文本未取得）/u.exec(lastLine);
        if (marker) end = lastLineStart + marker[0].length;
      } else if (lastLine.startsWith('page: ')) {
        const url = /^page: \S+/u.exec(lastLine);
        if (url) end = lastLineStart + url[0].length;
      }
      const selectorLine = lines.find((line) => line.startsWith('selector: ')) || '';
      const rawSelector = selectorLine.slice('selector: '.length);
      const degraded = rawSelector.includes('（degraded');
      const selector = rawSelector.replace(/（degraded.*$/u, '').trim();
      const pageLine = lines.find((line) => line.startsWith('page: ')) || '';
      const pageMatch = /^page: (\S+)/u.exec(pageLine);
      const rectLine = lines.find((line) => line.startsWith('rect(文档坐标): ')) || '';
      const rectMatch = /^rect\(文档坐标\): (x=-?[\d.]+, y=-?[\d.]+, [\d.]+×[\d.]+)/u.exec(rectLine);
      const truncatedLine = lines.find((line) => line.startsWith('outerHTML: ')) || '';
      const truncationMatch = /^outerHTML: (截断 \d+\/\d+ 码点（末尾 …，完整文本未取得）)/u.exec(truncatedLine);
      const label = '元素 ' + (selector || 'element');
      return {
        id: ELEMENT_TEXT_RULE_ID,
        start,
        end,
        data: {
          label,
          selector: selector || null,
          degraded,
          rect: rectMatch ? rectMatch[1].trim() : null,
          page: pageMatch ? pageMatch[1] : null,
          truncation: truncationMatch ? truncationMatch[1].trim() : null,
        },
      };
    }

    /** transcript 内联渲染：紧凑引用 chip；完整文本放在 title（悬停可见）。 */
    function ElementReferenceTextNode(props) {
      const raw = props && typeof props.raw === 'string' ? props.raw : '';
      const node = props && props.node && typeof props.node === 'object' ? props.node : null;
      const data = node && node.data && typeof node.data === 'object' ? node.data : {};
      const label = typeof data.label === 'string' && data.label ? data.label : '元素';
      const title = [label, data.rect ? 'rect: ' + data.rect : '', data.page ? 'page: ' + data.page : '',
        data.truncation || '', raw].filter(Boolean).join('\n');
      return h('span', {
        className: 'utb-user-element-ref',
        title,
        'data-utb-user-element-ref': typeof data.selector === 'string' ? data.selector : '',
        'data-utb-user-element-degraded': data.degraded === true ? 'true' : 'false',
        style: {
          display: 'inline-flex', alignItems: 'center', gap: '4px', padding: '0 7px',
          borderRadius: '6px', border: '1px solid rgba(127,127,127,0.35)',
          background: 'rgba(127,127,127,0.16)', fontSize: '0.92em', lineHeight: '1.6',
          maxWidth: '340px', overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap',
          verticalAlign: 'baseline', cursor: 'help',
        },
      }, label);
    }

    /** 注册 transcript 文本规则与对应的内联渲染节点；服务缺失时静默跳过。 */
    function registerUserTextElementReference(ctx) {
      if (!ctx) return false;
      let ruleInstalled = false;
      const installSlot = () => {
        if (elementTextRuleState.slotRegistered) return;
        try {
          ctx.slots.inject('conversation.user.text.node', function* () {
            yield ctx.slots.register({
              name: 'conversation.user.text.node', key: ELEMENT_TEXT_RULE_ID, priority: 100,
            }, ElementReferenceTextNode);
          });
          elementTextRuleState.slotRegistered = true;
        } catch { /* slot absent: transcript keeps plain text */ }
      };
      const installRule = (host) => {
        if (ruleInstalled) return true;
        let service = null;
        try { service = host && typeof host.get === 'function' ? host.get('uiConversation') : null; } catch { service = null; }
        const userText = service && service.userText;
        if (!userText || typeof userText.register !== 'function') return false;
        try {
          const dispose = userText.register({ id: ELEMENT_TEXT_RULE_ID, order: 20, match: elementTextBlockMatch });
          ruleInstalled = true;
          elementTextRuleState.registered = true;
          if (typeof ctx.effect === 'function') ctx.effect(() => dispose, 'ui-testing: transcript element reference rule');
          return true;
        } catch {
          return false;
        }
      };
      installSlot();
      // The conversation service may settle after this plugin's apply(): register when it exists.
      if (typeof ctx.inject === 'function') {
        try { ctx.inject(['uiConversation'], (sub) => { installRule(sub); }); } catch { /* immediate install below */ }
      }
      return installRule(ctx);
    }

    /** 归一化 Host 命中结果；无有效矩形时返回 null（不画框）。 */
    function pickOverlayOf(element) {
      if (!element || typeof element !== 'object') return null;
      const rect = element.rect && typeof element.rect === 'object' ? element.rect : null;
      const x = Number(rect && rect.x);
      const y = Number(rect && rect.y);
      const width = Number(rect && rect.width);
      const height = Number(rect && rect.height);
      if (!Number.isFinite(x) || !Number.isFinite(y) || !Number.isFinite(width) || !Number.isFinite(height)
        || !(width > 0) || !(height > 0)) return null;
      return {
        rect: { x, y, width, height },
        label: pickTagLabel(element),
        selector: pickCollapseText(element.selector),
        role: pickCollapseText(element.role),
        name: pickCollapseText(element.name),
        frameId: element.frameId === undefined || element.frameId === null ? '' : String(element.frameId),
      };
    }
    /** 文档 CSS px → .utb-box 内相对屏幕矩形：geom.left + (d−C)/viewW*geom.width。 */
    function pickScreenRect(overlay, geom, canvas, size, boxRect) {
      if (!overlay || !overlay.rect || !geom || !canvas || !size || !boxRect) return null;
      const viewW = Number(size.w);
      const viewH = Number(size.h);
      const paintedW = Number(geom.width);
      const paintedH = Number(geom.height);
      if (!(viewW > 0) || !(viewH > 0) || !(paintedW > 0) || !(paintedH > 0)) return null;
      const left = Number(geom.left) + ((overlay.rect.x - Number(canvas.x)) / viewW) * paintedW - Number(boxRect.left);
      const top = Number(geom.top) + ((overlay.rect.y - Number(canvas.y)) / viewH) * paintedH - Number(boxRect.top);
      const width = Math.max(1, (overlay.rect.width / viewW) * paintedW);
      const height = Math.max(1, (overlay.rect.height / viewH) * paintedH);
      if (![left, top, width, height].every((value) => Number.isFinite(value))) return null;
      return { left, top, width, height };
    }
    /** 左上角标签位置：默认贴在框上方，越界时夹紧到画布内。 */
    function pickTagPosition(screen, boxW, boxH) {
      if (!screen) return null;
      const width = Math.max(0, Number(boxW) || 0);
      const height = Math.max(0, Number(boxH) || 0);
      const left = Math.min(Math.max(0, screen.left), Math.max(0, width - 8));
      const top = screen.top - 18 >= 0
        ? screen.top - 18
        : Math.min(Math.max(0, screen.top + 2), Math.max(0, height - 18));
      return { left, top };
    }
    function pickChatFailureText(reason) {
      if (reason === 'busy') return '聊天框正在发送，稍后再试';
      if (reason === 'not-retained') return '该会话未保留，无法加入聊天框（请在会话打开时操作）';
      if (reason === 'stale-binding') return '会话已切换，请重试';
      if (reason === 'no-session') return '当前面板未绑定会话，无法加入聊天框';
      if (reason === 'unavailable') return '聊天框接口不可用，无法加入';
      return '加入聊天框失败，请重试';
    }
    /** 旧 Host（未重启、没有 /element 路由）与普通读失败分开提示。 */
    function pickElementFailureText(error) {
      const code = String((error && error.code) || '');
      const message = String((error && error.message) || '');
      if (code === 'UNSUPPORTED' || code === 'NOT_FOUND' || code === 'TOOL_NOT_FOUND'
        || /未知指令|unknown action|unsupported|not\s*found/i.test(message)) {
        return '当前宿主不支持选元素，请重启 DSH 后刷新面板';
      }
      return '获取元素失败，请稍后重试';
    }
    /** 输入框/可编辑区内的 Esc 不劫持（选元素模式退出监听用）。 */
    function pickEditableTarget(target) {
      if (!target || typeof target !== 'object') return false;
      if (target.isContentEditable === true) return true;
      const tag = String(target.tagName || '').toLowerCase();
      return tag === 'input' || tag === 'textarea' || tag === 'select';
    }
    /* ---- end pick pure helpers ---- */
    /** P0-D annotation layer: SVG namespace for the imperative draft node. */
    const SVG_NS = 'http://www.w3.org/2000/svg';
    /** P0-D annotation defaults (docs/viewport-control.md). */
    const ANNOT_DEFAULT = Object.freeze({ tool: 'rect', color: '#ff3b30', width: 3, fill: false, stroke: true });
    /**
     * 用户 2026-11-03 第 1 条：填充/外框是互斥选择（单一真源 mode）。非闭合工具与文字按工具
     * 冻结样式，只有圆形/矩形跟随 mode；橡皮擦不产出图形。Host 契约不变（仍是 fill/stroke 布尔）。
     */
    function annotStyleFor(tool, mode) {
      if (tool === 'text') return { fill: true, stroke: false };
      if (tool === 'line' || tool === 'arrow' || tool === 'brush') return { fill: false, stroke: true };
      return mode === 'fill' ? { fill: true, stroke: false } : { fill: false, stroke: true };
    }
    /**
     * 选择类工具（v3，2026-11-12）：只改面板本地选中态，不产生图形、不写 Host 文档。
     * `select` 点选/拖动已选图形，`marquee` 用矩形框选多个；两者与绘制/橡皮擦/文字互斥。
     */
    const ANNOT_SELECTION_TOOLS = Object.freeze(['select', 'marquee']);
    function annotIsSelectionTool(tool) {
      return ANNOT_SELECTION_TOOLS.includes(tool);
    }
    const ANNOT_TOOLS = Object.freeze([
      // 选择/框选放在工具栏最左侧（用户 2026-11-12 要求），绘制工具的相对顺序不变。
      Object.freeze({ id: 'select', label: '选择' }),
      Object.freeze({ id: 'marquee', label: '框选' }),
      Object.freeze({ id: 'circle', label: '圆形' }),
      Object.freeze({ id: 'rect', label: '矩形' }),
      Object.freeze({ id: 'line', label: '线段' }),
      Object.freeze({ id: 'arrow', label: '箭头' }),
      Object.freeze({ id: 'brush', label: '画笔' }),
      Object.freeze({ id: 'text', label: '文字' }),
      // 第七个工具（v2，docs/viewport-control.md）：单选、与其他六个互斥、不产生图形。
      Object.freeze({ id: 'eraser', label: '橡皮擦' }),
    ]);
    /** P0-D v2 上报（docs/viewport-control.md）：150ms trailing 合并、500ms 单次重试。 */
    const ANNOT_PUBLISH_DEBOUNCE_MS = 150;
    const ANNOT_PUBLISH_RETRY_MS = 500;
    /** 橡皮擦命中半径 r=max(strokeWidth/2,6) 画布 CSS px；长拖插值步长 ≤3 画布 px（§11.4）。 */
    const ANNOT_ERASE_MIN_RADIUS = 6;
    const ANNOT_ERASE_STEP_PX = 3;
    /** 软限额（§11.2）：客户端与 Host 同一确定性规则；客户端先裁剪并如实上报 truncation。 */
    const ANNOT_LIMITS = Object.freeze({
      shapes: 128,
      brushPoints: 512,
      documentPoints: 8192,
      textChars: 200,
      bytes: 65536,
    });

    /* ------------------------------------------------------------------------------------------
     * P0-D v3 标注工作区保留（docs/viewport-control.md）。
     *
     * The Host already stores one annotation document per workspace Runtime and already isolates
     * workspaces. The client's remaining jobs are:
     *   1. hydrate `ui.annotations` into the panel (after the runtime/revision/view acceptance);
     *   2. never turn "this panel unmounted / this tab hid / the scope changed" into an empty
     *      `release` document (that used to erase the workspace document on the Host);
     *   3. keep unacknowledged content + the publisher identity in module-level state so a remount
     *      can continue where the previous mount stopped, without depending on React state.
     *
     * `annotPublishers` is keyed by the authenticated opaque scope id + runtimeId + surface, i.e.
     * one logical publisher per workspace/runtime/panel-seat. `sessionStorage` persists only the
     * panel UUID and the last allocated clientRevision (never paths, session ids or shapes).
     * ---------------------------------------------------------------------------------------- */
    const ANNOT_STORAGE_PREFIX = 'dsh.ui-testing.annotations.v3';
    const ANNOT_ID_PATTERN = /^a[1-9][0-9]{0,15}$/;
    const ANNOT_UUID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
    const annotPublishers = new Map();
    let annotMountSerial = 0;

    function annotNewUuid() {
      let id = '';
      try {
        if (typeof crypto !== 'undefined' && crypto && typeof crypto.randomUUID === 'function') id = String(crypto.randomUUID());
      } catch { id = ''; }
      if (ANNOT_UUID_PATTERN.test(id)) return id;
      const hex = (count) => {
        let text = '';
        for (let index = 0; index < count; index += 1) text += Math.floor(Math.random() * 16).toString(16);
        return text;
      };
      return hex(8) + '-' + hex(4) + '-4' + hex(3) + '-a' + hex(3) + '-' + hex(12);
    }

    function annotStorageKey(scopeId, runtimeId, surface) {
      return [ANNOT_STORAGE_PREFIX, String(scopeId || ''), String(runtimeId || ''), String(surface || 'main')].join('|');
    }

    /** sessionStorage is optional: a blocked/absent store degrades to the module registry (§12.4). */
    function annotStorageRead(key) {
      try {
        const raw = window.sessionStorage.getItem(key);
        if (!raw) return null;
        const parsed = JSON.parse(raw);
        return parsed && typeof parsed === 'object' ? parsed : null;
      } catch { return null; }
    }

    function annotStorageWrite(key, value) {
      try { window.sessionStorage.setItem(key, JSON.stringify(value)); } catch { /* degrade */ }
    }

    function annotPublisherGet(scopeId, runtimeId, surface) {
      const key = annotStorageKey(scopeId, runtimeId, surface);
      let entry = annotPublishers.get(key);
      if (entry) return entry;
      const stored = annotStorageRead(key) || {};
      const storedRevision = Number.isSafeInteger(stored.lastAllocatedClientRevision)
        ? Math.max(0, stored.lastAllocatedClientRevision) : 0;
      const panelId = typeof stored.panelId === 'string' && ANNOT_UUID_PATTERN.test(stored.panelId)
        ? stored.panelId : annotNewUuid();
      entry = {
        key, panelId, surface: String(surface || 'main'),
        clientRevision: storedRevision,
        // Visible/queue bookkeeping (module-owned so an unmount cannot lose it).
        queued: null, inflight: null, retryTimer: 0, retried: false,
        dirty: false, pendingShapes: null, pendingTruncation: null, pendingContentSeq: 0, pendingDKey: '',
        lastError: false,
        hostRevision: 0, ackedClientRevision: 0,
        activeDKey: '', activeGeneration: 0, activeEpoch: -1,
        subscribers: new Set(),
      };
      annotPublishers.set(key, entry);
      if (stored.panelId !== panelId || storedRevision !== entry.clientRevision) {
        annotStorageWrite(key, { panelId, lastAllocatedClientRevision: entry.clientRevision });
      }
      return entry;
    }

    /** Persist *before* the request: a reload must never reuse an already-sent revision (§12.4). */
    function annotPublisherPersist(entry) {
      annotStorageWrite(entry.key, { panelId: entry.panelId, lastAllocatedClientRevision: entry.clientRevision });
    }

    function annotPublisherAllocate(entry) {
      entry.clientRevision = Math.max(0, Math.floor(entry.clientRevision)) + 1;
      annotPublisherPersist(entry);
      return entry.clientRevision;
    }

    function annotPublisherSubscribe(entry, listener) {
      entry.subscribers.add(listener);
      return () => entry.subscribers.delete(listener);
    }

    function annotPublisherEmit(entry, event) {
      for (const listener of [...entry.subscribers]) {
        try { listener(event); } catch { /* a subscriber must not break the queue */ }
      }
    }

    /** Remember the newest unconfirmed local content without queueing a request. */
    function annotPublisherRemember(entry, facts) {
      entry.dirty = true;
      entry.pendingShapes = facts.shapes;
      entry.pendingTruncation = facts.truncation || { droppedShapes: 0, droppedPoints: 0, shortenedTextCodeUnits: 0 };
      entry.pendingContentSeq = facts.contentSeq;
      entry.pendingDKey = facts.dKey || entry.pendingDKey;
    }

    /** Enqueue the newest snapshot (at most one waiting) and drain. */
    function annotPublisherQueue(entry, snapshot) {
      annotPublisherRemember(entry, {
        shapes: snapshot.shapes,
        truncation: snapshot.truncation,
        contentSeq: snapshot.contentSeq,
        dKey: snapshot.dKey,
      });
      entry.queued = snapshot;
      entry.lastError = false;
      annotPublisherDrain(entry);
    }

    function annotPublisherBody(snapshot) {
      return {
        version: 1,
        panelId: snapshot.panelId,
        surface: snapshot.surface,
        clientRevision: snapshot.clientRevision,
        context: snapshot.context,
        view: snapshot.view,
        shapes: snapshot.release ? [] : snapshot.shapes,
        truncation: snapshot.truncation,
        release: Boolean(snapshot.release),
      };
    }

    function annotPublisherDrain(entry) {
      if (!entry || entry.inflight || !entry.queued) return;
      const snapshot = entry.queued;
      entry.queued = null;
      entry.inflight = snapshot;
      annotPublisherSend(entry, snapshot, false);
    }

    async function annotPublisherSend(entry, snapshot, isRetry) {
      let status = 0;
      let payload = null;
      let failure = null;
      try {
        const response = await fetch(HOST_BASE + '/annotations', {
          method: 'POST',
          headers: Object.assign({ 'content-type': 'application/json' }, scopeHeaders(snapshot.scope)),
          credentials: 'same-origin',
          body: JSON.stringify(annotPublisherBody(snapshot)),
        });
        status = Number(response.status) || 0;
        payload = await response.json().catch(() => ({}));
      } catch (error) {
        failure = error;
      }
      if (entry.inflight === snapshot) entry.inflight = null;
      const current = () => snapshot.dKey === entry.activeDKey
        || (entry.activeDKey === '' && snapshot.clientRevision === entry.clientRevision);
      if (!failure && status === 200 && payload && payload.ok !== false) {
        const accepted = payload.annotations && typeof payload.annotations === 'object' ? payload.annotations : null;
        if (accepted && Number.isSafeInteger(Number(accepted.revision))) {
          entry.hostRevision = Math.max(entry.hostRevision, Math.max(0, Number(accepted.revision)));
        }
        const ackedRevision = Number.isFinite(Number(payload.clientRevision))
          ? Number(payload.clientRevision) : Number(snapshot.clientRevision);
        if (Number.isSafeInteger(ackedRevision) && ackedRevision > 0) {
          entry.ackedClientRevision = Math.max(entry.ackedClientRevision, ackedRevision);
        }
        entry.lastError = false;
        if (snapshot.contentSeq === entry.pendingContentSeq) {
          entry.dirty = false;
          entry.pendingShapes = null;
          entry.pendingTruncation = null;
        }
        annotPublisherEmit(entry, { type: 'ack', snapshot, annotations: accepted, ignored: payload.ignored === true, current: current() });
        annotPublisherDrain(entry);
        return;
      }
      const reason = payload && typeof payload === 'object'
        ? (payload.reason || (payload.details && payload.details.reason))
        : '';
      if (status === 409 && reason === 'annotation-context-stale') {
        // Only the stale document's queue is discarded; another workspace keeps its content.
        if (snapshot.dKey === entry.activeDKey || entry.activeDKey === '') {
          if (entry.queued && entry.queued.dKey === snapshot.dKey) entry.queued = null;
          if (snapshot.contentSeq >= entry.pendingContentSeq) {
            entry.dirty = false;
            entry.pendingShapes = null;
            entry.pendingTruncation = null;
          }
        }
        entry.lastError = false;
        annotPublisherEmit(entry, { type: 'stale', snapshot, current: current() });
        annotPublisherDrain(entry);
        return;
      }
      const retryable = Boolean(failure) || status >= 500 || status === 0;
      if (retryable && !isRetry) {
        if (entry.retryTimer) window.clearTimeout(entry.retryTimer);
        entry.retryTimer = window.setTimeout(() => {
          entry.retryTimer = 0;
          // Still the newest content for this publisher, and the identity is unchanged: one retry
          // with the exact same revision/body. A newer snapshot replaced it → drop the retry.
          if (entry.inflight || entry.queued) return;
          if (snapshot.clientRevision !== entry.clientRevision) return;
          if (snapshot.dKey !== entry.activeDKey && entry.activeDKey !== '') return;
          entry.inflight = snapshot;
          annotPublisherEmit(entry, { type: 'error', snapshot, final: false, current: current() });
          annotPublisherSend(entry, snapshot, true);
        }, ANNOT_PUBLISH_RETRY_MS);
        // A newer snapshot may already be waiting; it must not be blocked by the old retry timer.
        annotPublisherDrain(entry);
        return;
      }
      entry.lastError = true;
      annotPublisherEmit(entry, { type: 'error', snapshot, final: true, current: current() });
      annotPublisherDrain(entry);
    }
    /** 拖拽视口：移动期间写入共享 view 的最小间隔（Host 一次 set 本身要两帧+稳定读回）。 */
    const PAN_WRITE_THROTTLE_MS = 80;

    function clampNumber(value, min, max) {
      const number = Number(value);
      if (!Number.isFinite(number)) return min;
      return Math.max(min, Math.min(max, number));
    }

    /** Finite number, or null for missing/invalid metadata (never coerces null to 0). */
    function finiteOrNull(value) {
      if (value === null || value === undefined || value === '') return null;
      const number = Number(value);
      return Number.isFinite(number) ? number : null;
    }

    /** `ui.view` (v1) from any Host snapshot shape; null for an old Host without shared view. */
    function viewOf(payload) {
      if (!payload || typeof payload !== 'object') return null;
      const state = payload.state && typeof payload.state === 'object' ? payload.state : payload;
      const ui = state && state.ui && typeof state.ui === 'object' ? state.ui : null;
      const view = ui && ui.view && typeof ui.view === 'object' && Number(ui.view.version) === 1 ? ui.view : null;
      return view;
    }

    /** `ui.viewMeta` / `ui.observed` companions of the same snapshot. */
    function viewCompanionsOf(payload) {
      const state = payload && payload.state && typeof payload.state === 'object' ? payload.state : payload;
      const ui = state && state.ui && typeof state.ui === 'object' ? state.ui : null;
      return {
        viewMeta: ui && ui.viewMeta && typeof ui.viewMeta === 'object' ? ui.viewMeta : null,
        observed: ui && ui.observed && typeof ui.observed === 'object' ? ui.observed : null,
      };
    }

    /**
     * Shared canvas projection (`ui.canvas`, docs/viewport-control.md). Its presence is the
     * capability handshake: a Host without it is an old Host, so the panel keeps the legacy
     * scroll-only X/Y behaviour and disables canvas editing/drag (fail closed, no guessing).
     */
    function canvasOf(payload) {
      if (!payload || typeof payload !== 'object') return null;
      const state = payload.state && typeof payload.state === 'object' ? payload.state : payload;
      const ui = state && state.ui && typeof state.ui === 'object' ? state.ui : null;
      const canvas = ui && ui.canvas && typeof ui.canvas === 'object' && Number(ui.canvas.version) === 1 ? ui.canvas : null;
      return canvas;
    }

    /** Draw-displacement inputs of one displayed frame (canvas compositing, §5.2). */
    function frameScrollOf(meta, fallback) {
      const pick = (key) => {
        if (!meta || meta[key] === undefined || meta[key] === null) return null;
        const value = Number(meta[key]);
        if (Number.isFinite(value)) return value;
        return fallback && Number.isFinite(Number(fallback[key])) ? Number(fallback[key]) : null;
      };
      return { x: pick('scrollX'), y: pick('scrollY') };
    }

    /** Round a canvas coordinate to two decimals (Host accepts CSS floats). */
    function roundCanvas(value) {
      return Math.round(Number(value) * 100) / 100;
    }

    /**
     * Painted image rect for `object-fit: contain; object-position: 50% 50%` (contract §5.1).
     * `rect` is the img content box in *host* CSS px (border/padding already excluded by the
     * layout), natural* are the decoded frame pixels. The host window DPR never enters this
     * formula: event.clientX/Y, getBoundingClientRect and the target viewport are all CSS px.
     */
    /** 单选 <select> 面板浮层的几何参数（纯数据；契约测试按源码抽取校验）。 */
    const SELECT_POP_GEOMETRY = {
      itemHeight: 26, minWidth: 160, maxWidth: 280, edge: 8, gap: 4, pad: 4, maxVisibleItems: 12,
    };
    /** 点击与按下点之间的最大偏移：超过就算拖拽，不弹浮层。 */
    const SELECT_CLICK_SLOP_PX = 4;

    /**
     * 原生 <select> 浮层的定位（纯函数，无 DOM）。
     *
     * 输入：点击点在画面框内的 CSS px、要显示的行数、画面框的可用宽高；输出浮层的
     * left/top/width/maxHeight 以及是否上翻/左移。规则：
     *   ① 优先在点击点下方展开；② 下方放不下、上方放得下 → 上翻；
     *   ③ 两侧都放不下 → 取空间较大的一侧，并把高度截断（列表内部滚动）；
     *   ④ 任何情况下都夹在框内（edge 内边距），水平越界则左移。
     * 行数再乘 itemHeight 得到自然高度；maxVisibleItems 是"不滚动时最多显示几行"的上限。
     */
    function selectPopLayout(point, itemCount, bounds) {
      const g = SELECT_POP_GEOMETRY;
      const boxW = Math.max(0, Number(bounds && bounds.width) || 0);
      const boxH = Math.max(0, Number(bounds && bounds.height) || 0);
      const rawX = Number(point && point.x);
      const rawY = Number(point && point.y);
      const x = Number.isFinite(rawX) ? rawX : 0;
      const y = Number.isFinite(rawY) ? rawY : 0;
      const count = Math.max(0, Math.floor(Number(itemCount) || 0));
      // 高度按"最多 maxVisibleItems 行"算，但**所有条目都要渲染**（容器自己滚动）：
      // 截断只发生在高度上，绝不能把第 13 项之后的选项从列表里丢掉。
      const rowsForHeight = Math.max(1, Math.min(count, g.maxVisibleItems));
      const natural = rowsForHeight * g.itemHeight + g.pad * 2;
      const minHeight = g.itemHeight + g.pad * 2;
      const roomBelow = Math.max(0, boxH - y - g.gap - g.edge);
      const roomAbove = Math.max(0, y - g.gap - g.edge);
      let side = 'below';
      let top;
      let maxHeight;
      if (natural <= roomBelow) {
        top = y + g.gap;
        maxHeight = natural;
      } else if (natural <= roomAbove) {
        side = 'above';
        top = y - g.gap - natural;
        maxHeight = natural;
      } else if (roomBelow >= roomAbove) {
        top = y + g.gap;
        maxHeight = Math.max(minHeight, Math.min(natural, roomBelow));
      } else {
        side = 'above';
        maxHeight = Math.max(minHeight, Math.min(natural, roomAbove));
        top = y - g.gap - maxHeight;
      }
      // ④ 硬夹进画面框：极端窄/矮面板也不许画到框外。
      if (top + maxHeight > boxH - g.edge) top = boxH - g.edge - maxHeight;
      if (top < g.edge) top = g.edge;
      const room = Math.max(1, boxW - g.edge * 2);
      const preferred = Math.max(g.minWidth, Math.min(g.maxWidth, room));
      const width = Math.max(1, Math.min(preferred, room));
      const wantedLeft = x - g.pad;
      const lastLeft = Math.max(g.edge, boxW - g.edge - width);
      const left = Math.min(Math.max(g.edge, wantedLeft), lastLeft);
      const visibleItems = Math.max(1, Math.floor((maxHeight - g.pad * 2) / g.itemHeight));
      return {
        left: Math.round(left * 1000) / 1000,
        top: Math.round(top * 1000) / 1000,
        width: Math.round(width * 1000) / 1000,
        maxHeight: Math.round(maxHeight * 1000) / 1000,
        side,
        flippedUp: side === 'above',
        shiftedLeft: left < wantedLeft - 0.5,
        itemHeight: g.itemHeight,
        pad: g.pad,
        visibleItems,
        scrolls: count > visibleItems,
      };
    }

    function paintedRect(rect, naturalW, naturalH) {
      const nw = Number(naturalW) || 0;
      const nh = Number(naturalH) || 0;
      if (!nw || !nh || !rect || !(Number(rect.width) > 0) || !(Number(rect.height) > 0)) return null;
      const k = Math.min(Number(rect.width) / nw, Number(rect.height) / nh);
      const width = nw * k;
      const height = nh * k;
      return {
        left: Number(rect.left) + (Number(rect.width) - width) / 2,
        top: Number(rect.top) + (Number(rect.height) - height) / 2,
        width,
        height,
        naturalW: nw,
        naturalH: nh,
      };
    }

    /**
     * One wheel delta in *target page* CSS px. deltaMode is fixed, not guessed:
     * 0 = host CSS px, 1 = 16 CSS px per line, 2 = one page (painted rect) per unit.
     */
    function frameWheelDelta(delta, mode, paintedSize, viewportSize) {
      const raw = Number(delta) || 0;
      if (!raw) return 0;
      if (!(paintedSize > 0) || !(viewportSize > 0)) return 0;
      if (Number(mode) === 1) return raw * FRAME_WHEEL_LINE_CSS_PX * (viewportSize / paintedSize);
      if (Number(mode) === 2) return raw * viewportSize;
      return raw * (viewportSize / paintedSize);
    }

    const CSS = `
.utb { height: 100%; min-height: 0; display: flex; flex-direction: column; color: var(--dsw-alias-label-primary); background: var(--dsw-alias-bg-base); font: 13px/1.5 system-ui, -apple-system, "Segoe UI", sans-serif; }
.utb * { box-sizing: border-box; }
.utb-top { display: flex; align-items: center; gap: 10px; flex: 0 0 auto; min-height: 44px; padding: 6px 10px; background: var(--dsw-alias-bg-layer-1); border-bottom: 1px solid var(--dsw-alias-border-l1); }
.utb-env-icon { display: grid; place-items: center; width: 30px; height: 30px; flex: 0 0 auto; color: var(--dsw-alias-label-secondary); background: var(--dsw-alias-bg-base); border: 1px solid var(--dsw-alias-border-l1); border-radius: 9px; }
.utb-env-text { display: flex; align-items: center; min-height: 30px; min-width: 0; }
.utb-env-title { font-size: 13px; font-weight: 600; line-height: 17px; color: var(--dsw-alias-label-primary); overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
.utb-env-pick { position: relative; display: inline-flex; align-items: center; flex: 0 0 auto; }
.utb-select { appearance: none; -webkit-appearance: none; height: 26px; padding: 0 26px 0 10px; font: inherit; font-size: 12px; color: var(--dsw-alias-label-primary); background: var(--dsw-alias-bg-base); border: 1px solid var(--dsw-alias-border-l2); border-radius: 8px; cursor: pointer; }
.utb-select:focus-visible { outline: 2px solid var(--dsw-alias-brand-primary); outline-offset: 1px; }
.utb-select option:disabled { color: var(--dsw-alias-label-secondary); }
.utb-env-caret { position: absolute; right: 7px; display: grid; place-items: center; pointer-events: none; color: var(--dsw-alias-label-secondary); }
.utb-env-error { max-width: 220px; font-size: 11px; line-height: 14px; color: #f59e0b; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
.utb-sr { position: absolute; width: 1px; height: 1px; margin: -1px; padding: 0; overflow: hidden; clip: rect(0 0 0 0); white-space: nowrap; border: 0; }
.utb-bar { display: flex; align-items: center; gap: 4px; padding: 6px 8px; flex: 0 0 auto; background: var(--dsw-alias-bg-layer-1); border-bottom: 1px solid var(--dsw-alias-border-l1); }
.utb-btn { display: inline-flex; align-items: center; justify-content: center; width: 28px; height: 28px; padding: 0; flex: 0 0 auto; color: var(--dsw-alias-label-secondary); background: transparent; border: 1px solid transparent; border-radius: 6px; cursor: pointer; }
.utb-btn:hover:not(:disabled) { color: var(--dsw-alias-label-primary); background: var(--dsw-alias-bg-layer-2); }
.utb-btn[aria-pressed="true"] { color: var(--dsw-alias-brand-primary); background: var(--dsw-alias-bg-layer-2); }
.utb-btn:disabled { opacity: .38; cursor: not-allowed; }
.utb-addr { flex: 1 1 auto; min-width: 0; height: 28px; padding: 0 10px; font: inherit; color: var(--dsw-alias-label-primary); background: var(--dsw-alias-bg-base); border: 1px solid var(--dsw-alias-border-l1); border-radius: 6px; }
.utb-addr::placeholder { color: var(--dsw-alias-label-secondary); }
.utb-addr[data-invalid="true"] { border-color: var(--dsw-alias-state-error-primary); outline-color: var(--dsw-alias-state-error-primary); }
.utb-addr:focus-visible, .utb-btn:focus-visible, .utb-menu-item:focus-visible, .utb-num:focus-visible, .utb-addr-hist:focus-visible { outline: 2px solid var(--dsw-alias-brand-primary); outline-offset: 1px; }
.utb-addr-wrap { position: relative; display: flex; align-items: center; flex: 1 1 auto; min-width: 0; }
.utb-addr-wrap .utb-addr { flex: 1 1 auto; padding-right: 30px; }
.utb-addr-hist { position: absolute; top: 2px; right: 2px; bottom: 2px; display: inline-flex; align-items: center; justify-content: center; width: 24px; padding: 0; border: 0; border-radius: 4px; background: transparent; color: var(--dsw-alias-label-secondary); cursor: pointer; }
.utb-addr-hist:hover { background: var(--dsw-alias-bg-layer-2); color: var(--dsw-alias-label-primary); }
.utb-addr-hist:disabled { opacity: .45; cursor: not-allowed; }
.utb-addr-hist[data-utb-history-toggle="open"] { background: var(--dsw-alias-bg-layer-2); color: var(--dsw-alias-label-primary); }
.utb-addr-pop { right: 0; left: auto; min-width: 100%; max-width: 560px; max-height: 264px; overflow: auto; }
.utb-addr-pop-head { padding: 4px 8px 6px; font-size: 12px; line-height: 16px; color: var(--dsw-alias-label-secondary); }
.utb-addr-pop-empty { padding: 8px; font-size: 12px; color: var(--dsw-alias-label-secondary); }
.utb-addr-label { overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
.utb-more { position: relative; flex: 0 0 auto; }
.utb-pop { position: absolute; right: 0; top: calc(100% + 4px); z-index: 20; min-width: 208px; padding: 4px; background: var(--dsw-alias-bg-overlay); border: 1px solid var(--dsw-alias-border-l1); border-radius: 8px; box-shadow: 0 8px 24px rgba(0,0,0,.28); }
.utb-menu-item { display: flex; align-items: center; gap: 8px; width: 100%; padding: 7px 10px; font: inherit; text-align: left; color: var(--dsw-alias-label-primary); background: transparent; border: 0; border-radius: 6px; cursor: pointer; }
.utb-menu-item:hover:not(:disabled) { background: var(--dsw-alias-bg-layer-2); }
.utb-menu-item:disabled { color: var(--dsw-alias-label-secondary); opacity: .6; cursor: not-allowed; }
/* 原生 <select> 的面板侧浮层（浏览器弹层在 UI 图层，帧里看不到）。
   观感复用 .utb-pop 那一套 token；定位由 selectPopLayout 纯函数给出。 */
.utb-select-pop { overflow-y: auto; overflow-x: hidden; padding: 4px; background: var(--dsw-alias-bg-overlay); border: 1px solid var(--dsw-alias-border-l1); border-radius: 8px; box-shadow: 0 8px 24px rgba(0,0,0,.28); outline: none; }
.utb-select-pop:focus-visible { outline: 2px solid var(--dsw-alias-brand-primary); outline-offset: 1px; }
.utb-select-pop-item { display: block; width: 100%; padding: 4px 8px; font-size: 12px; line-height: 18px; color: var(--dsw-alias-label-primary); border-radius: 6px; white-space: nowrap; overflow: hidden; text-overflow: ellipsis; cursor: pointer; }
.utb-context-menu button { background: transparent; font-family: inherit; }
.utb-select-pop-item:hover { background: var(--dsw-alias-bg-layer-2); }
.utb-select-pop-item[data-utb-select-item="active"] { background: var(--dsw-alias-bg-layer-3, var(--dsw-alias-bg-layer-2)); color: var(--dsw-alias-brand-primary); }
.utb-select-pop-item[data-utb-select-item="disabled"] { color: var(--dsw-alias-label-secondary); opacity: .55; cursor: not-allowed; }
/* 调试工具弹窗被拦截时的本地提示 + 可点击降级链接（不写 Runtime lastError）。 */
.utb-devtools-note { display: flex; align-items: center; gap: 8px; flex: 0 0 auto; flex-wrap: wrap; row-gap: 4px; padding: 6px 8px; font-size: 12px; color: var(--dsw-alias-label-secondary); background: var(--dsw-alias-bg-layer-1); border-bottom: 1px solid var(--dsw-alias-border-l1); }
.utb-devtools-note a { color: var(--dsw-alias-brand-primary); text-decoration: underline; }
/* Canvas 同步/输入本地提示：纯客户端状态，不写 Runtime lastError，不伪造 view revision。 */
.utb-sync-note { display: flex; align-items: center; gap: 8px; flex: 0 0 auto; flex-wrap: wrap; row-gap: 4px; padding: 6px 8px; font-size: 12px; color: var(--dsw-alias-label-secondary); background: var(--dsw-alias-bg-layer-1); border-bottom: 1px solid var(--dsw-alias-border-l1); }
.utb-sync-note button { font: inherit; padding: 2px 8px; border-radius: 6px; border: 1px solid var(--dsw-alias-border-l1); background: var(--dsw-alias-bg-layer-2); color: var(--dsw-alias-label-primary); cursor: pointer; }
/* 内部浏览器标签栏（同一个调试视图内，地址栏下方；仅由开关控制显隐，单标签也占行）。 */
.utb-tabs { display: flex; align-items: center; gap: 4px; flex: 0 0 auto; padding: 4px 6px; overflow-x: auto; overflow-y: hidden; border-bottom: 1px solid var(--dsw-alias-border-l1); background: var(--dsw-alias-bg-layer-1); scrollbar-width: thin; }
.utb-tab { display: inline-flex; align-items: center; gap: 4px; flex: 0 0 auto; max-width: 220px; padding: 3px 6px; border: 1px solid var(--dsw-alias-border-l1); border-radius: 6px; background: var(--dsw-alias-bg-layer-2); color: var(--dsw-alias-label-secondary); font: 12px/1.5 inherit; white-space: nowrap; cursor: pointer; }
.utb-tab[aria-selected="true"] { color: var(--dsw-alias-label-primary); border-color: var(--dsw-alias-brand-primary); background: var(--dsw-alias-bg-layer-3, var(--dsw-alias-bg-layer-2)); }
.utb-tab-label { overflow: hidden; text-overflow: ellipsis; }
.utb-tab-close { flex: 0 0 auto; width: 18px; height: 18px; padding: 0; border: 0; border-radius: 4px; background: transparent; color: inherit; font: 14px/18px inherit; cursor: pointer; }
.utb-tab-close:hover { background: var(--dsw-alias-bg-layer-2); }
.utb-tab-new { display: inline-flex; align-items: center; justify-content: center; flex: 0 0 auto; width: 24px; height: 22px; padding: 0; border: 1px solid var(--dsw-alias-border-l1); border-radius: 6px; background: var(--dsw-alias-bg-layer-2); color: var(--dsw-alias-label-secondary); font: 16px/20px inherit; cursor: pointer; }
.utb-tab-new:hover { color: var(--dsw-alias-label-primary); }
.utb-tab-new:disabled { opacity: .45; cursor: default; }
.utb-tab-note { border-bottom: 1px solid var(--dsw-alias-border-l1); background: var(--dsw-alias-bg-layer-1); padding: 4px 8px; color: var(--dsw-alias-label-secondary); font: 12px/1.5 inherit; }
.utb-agent-note { color: var(--dsw-alias-label-secondary); }
.utb-tabs-glyph { font-size: 13px; line-height: 1; }
.utb-size { display: flex; align-items: center; gap: 8px; padding: 6px 8px; flex: 0 0 auto; flex-wrap: wrap; row-gap: 4px; font-size: 12px; color: var(--dsw-alias-label-secondary); background: var(--dsw-alias-bg-layer-1); border-bottom: 1px solid var(--dsw-alias-border-l1); }
/* P0-D 标注栏（用户 2026-11-02 要求）：独立横栏，正常单行 41px，窄面板换行不覆盖预览区。 */
.utb-annot-bar { display: flex; align-items: center; gap: 6px; padding: 6px 8px; flex: 0 0 auto; flex-wrap: wrap; row-gap: 4px; min-height: 41px; font-size: 12px; color: var(--dsw-alias-label-secondary); background: var(--dsw-alias-bg-layer-1); border-bottom: 1px solid var(--dsw-alias-border-l1); }
.utb-annot-group { display: inline-flex; align-items: center; gap: 4px; flex: 0 0 auto; flex-wrap: wrap; row-gap: 4px; }
.utb-annot-tool { width: 28px; height: 28px; }
.utb-annot-check { display: inline-flex; align-items: center; gap: 4px; flex: 0 0 auto; white-space: nowrap; cursor: pointer; }
.utb-annot-check input:disabled { cursor: not-allowed; }
.utb-annot-color { width: 30px; height: 24px; padding: 0; flex: 0 0 auto; background: var(--dsw-alias-bg-base); border: 1px solid var(--dsw-alias-border-l1); border-radius: 6px; cursor: pointer; }
.utb-annot-color:disabled { opacity: .55; cursor: not-allowed; }
.utb-annot-width { width: 54px; }
/* v2：横栏右侧的可见文案按钮「清除画布」（§11.4）与状态栏同步提示（§11.3）。 */
.utb-annot-shot { width: auto; min-width: 0; height: 28px; padding: 0 10px; font-size: 12px; line-height: 1; white-space: nowrap; border-color: var(--dsw-alias-border-l1); background: var(--dsw-alias-bg-base); }
.utb-annot-clear { width: auto; min-width: 0; height: 28px; padding: 0 10px; margin-left: auto; font-size: 12px; line-height: 1; white-space: nowrap; border-color: var(--dsw-alias-border-l1); background: var(--dsw-alias-bg-base); }
.utb-annot-delete { width: auto; min-width: 0; height: 28px; padding: 0 10px; font-size: 12px; line-height: 1; white-space: nowrap; border-color: var(--dsw-alias-border-l1); background: var(--dsw-alias-bg-base); }
/* 选中态（选择/框选）：品牌色光晕 + 半透明包围框 + 并行胶囊；纯面板 SVG 视觉，不进截图、不改图形数据。 */
.utb-annot-select-halo { opacity: .4; pointer-events: none; }
.utb-annot-select-halo * { stroke: #0b6bff !important; fill: none !important; stroke-width: 8 !important; vector-effect: non-scaling-stroke; }
.utb-annot-select-halo polygon { fill: #0b6bff !important; stroke: #0b6bff !important; }
.utb-annot-select-halo text { fill: #0b6bff !important; stroke: none !important; }
.utb-annot-select-group { pointer-events: none; }
.utb-annot-select-fill { fill: rgba(11, 107, 255, .16); stroke: none; pointer-events: none; }
.utb-annot-select-edge { fill: none; stroke: #fff; stroke-width: 3; vector-effect: non-scaling-stroke; pointer-events: none; }
.utb-annot-select-ants { fill: none; stroke: #0b6bff; stroke-width: 1.6; stroke-dasharray: 5 3; vector-effect: non-scaling-stroke; pointer-events: none; animation: utb-annot-ants 1s linear infinite; }
@keyframes utb-annot-ants { to { stroke-dashoffset: -8; } }
@media (prefers-reduced-motion: reduce) { .utb-annot-select-ants { animation: none; } }
.utb-annot-selected-status { flex: 0 0 auto; color: var(--dsw-alias-brand-primary); font-variant-numeric: tabular-nums; white-space: nowrap; }
.utb-annot-marquee-box { fill: color-mix(in srgb, var(--dsw-alias-brand-primary) 10%, transparent); stroke: var(--dsw-alias-brand-primary); stroke-width: 1; stroke-dasharray: 4 3; vector-effect: non-scaling-stroke; pointer-events: none; }
.utb-annot-sync { flex: 0 1 auto; min-width: 0; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; color: var(--dsw-alias-state-warn-primary); }
.utb-annot-layer { display: block; overflow: hidden; }
.utb-annot-layer:focus-visible { outline: 2px solid var(--dsw-alias-brand-primary); outline-offset: -2px; }
.utb-annot-text-input { position: absolute; margin: 0; padding: 0 2px; font-family: system-ui, -apple-system, "Segoe UI", sans-serif; font-weight: 400; line-height: 1.2; background: var(--dsw-alias-bg-base); border: 1px dashed currentColor; border-radius: 2px; outline: none; z-index: 3; }
/* 选元素模式：纯面板 DOM 的悬浮框（pointer-events:none，被 .utb-box 裁剪，不进 Host 截图）。 */
.utb-pick-layer { position: absolute; inset: 0; overflow: hidden; pointer-events: none; z-index: 3; }
.utb-pick-outline { position: absolute; pointer-events: none; border: 2px solid var(--dsw-alias-brand-primary); border-radius: 1px; background: color-mix(in srgb, var(--dsw-alias-brand-primary) 12%, transparent); box-shadow: 0 0 0 1px rgba(0, 0, 0, .28); }
.utb-pick-tag { position: absolute; max-width: 100%; padding: 1px 5px; font: 11px/1.5 ui-monospace, SFMono-Regular, Menlo, monospace; color: #fff; background: var(--dsw-alias-brand-primary); border-radius: 4px; white-space: nowrap; overflow: hidden; text-overflow: ellipsis; pointer-events: none; }
.utb-pick-note { color: var(--dsw-alias-brand-primary); }
.utb-pick-note[data-utb-pick-status="ok"] { color: var(--dsw-alias-state-success-primary); }
.utb-pick-note[data-utb-pick-status="error"] { color: var(--dsw-alias-state-error-primary); }
.utb-num { width: 62px; height: 26px; padding: 0 6px; font: inherit; font-size: 12px; color: var(--dsw-alias-label-primary); background: var(--dsw-alias-bg-base); border: 1px solid var(--dsw-alias-border-l1); border-radius: 6px; }
.utb-num:disabled { opacity: .55; cursor: not-allowed; }
.utb-size-left { display: flex; align-items: center; gap: 6px; flex: 0 0 auto; flex-wrap: wrap; row-gap: 4px; }
.utb-size-right { display: flex; align-items: center; gap: 6px; flex: 1 1 auto; flex-wrap: wrap; row-gap: 4px; justify-content: flex-end; min-width: 0; }
.utb-pos { width: 58px; }
.utb-pos-label { flex: 0 0 auto; font-variant-numeric: tabular-nums; }
.utb-check { display: inline-flex; align-items: center; gap: 5px; cursor: pointer; }
/* 用户 2026-11-03 第 1/4 条：分页选择器（填充/外框、拖拽/适应窗口）。 */
.utb-seg { display: inline-flex; align-items: stretch; height: 24px; flex: 0 0 auto; border: 1px solid var(--dsw-alias-border-l1); border-radius: 7px; overflow: hidden; background: var(--dsw-alias-bg-base); }
.utb-seg-btn { display: inline-flex; align-items: center; justify-content: center; gap: 2px; height: 100%; padding: 0 5px; font: inherit; font-size: 12px; line-height: 22px; color: var(--dsw-alias-label-secondary); background: transparent; border: 0; border-right: 1px solid var(--dsw-alias-border-l1); cursor: pointer; white-space: nowrap; }
.utb-seg-dot { width: 8px; height: 8px; flex: 0 0 8px; display: block; }
.utb-seg-btn:last-child { border-right: 0; }
.utb-seg-btn:hover:not(:disabled) { color: var(--dsw-alias-label-primary); background: var(--dsw-alias-bg-layer-2); }
.utb-seg-btn[aria-pressed="true"] { color: var(--dsw-alias-brand-primary); background: color-mix(in srgb, var(--dsw-alias-brand-primary) 12%, transparent); }
.utb-seg-btn:disabled { opacity: .38; cursor: not-allowed; }
.utb-seg-btn:focus-visible { outline: 2px solid var(--dsw-alias-brand-primary); outline-offset: -2px; }
.utb-dim { font-variant-numeric: tabular-nums; }
.utb-num.utb-zoom { width: 54px; text-align: right; }
.utb-stage { position: relative; flex: 1 1 auto; min-height: 0; overflow: auto; display: flex; align-items: safe center; justify-content: safe center; background: var(--dsw-alias-bg-layer-2); }
.utb-box { flex: 0 0 auto; overflow: hidden; background: var(--dsw-alias-bg-base); }
.utb-box[data-fitted="true"] { box-shadow: 0 0 0 1px var(--dsw-alias-border-l2); }
/* Canvas blank = dark checkerboard (user request). Fixed host px, not view.scale. The <img>
   above it covers the box whenever the frame proves the whole viewport (O=0), so old pixels
   are unchanged; only true composited blank shows through. */
.utb-box[data-utb-canvas="on"] {
  background-color: ${CANVAS_CHECKER.dark};
  background-image: repeating-conic-gradient(${CANVAS_CHECKER.dark} 0% 25%, ${CANVAS_CHECKER.light} 0% 50%);
  background-size: ${CANVAS_CHECKER.size * 2}px ${CANVAS_CHECKER.size * 2}px;
  background-position: 0 0;
}
.utb-frame { display: block; border: 0; background: #fff; }
.utb-empty { max-width: 320px; padding: 24px; text-align: center; color: var(--dsw-alias-label-secondary); }
.utb-empty strong { display: block; margin-bottom: 6px; color: var(--dsw-alias-label-primary); font-weight: 600; }
.utb-empty-error { color: var(--dsw-alias-state-error-primary); }
.utb-status { display: flex; align-items: center; gap: 8px; flex: 0 0 auto; height: 26px; padding: 0 10px; font-size: 11.5px; color: var(--dsw-alias-label-secondary); background: var(--dsw-alias-bg-layer-1); border-top: 1px solid var(--dsw-alias-border-l1); }
.utb-mode { display: inline-flex; align-items: center; gap: 6px; flex: 0 0 auto; font-weight: 500; }
.utb-mode[data-mode="idle"] { color: var(--dsw-alias-state-success-primary); }
.utb-mode[data-mode="human"] { color: var(--dsw-alias-state-warn-primary); }
.utb-mode[data-mode="agent"] { color: var(--dsw-alias-brand-primary); }
.utb-dot { width: 6px; height: 6px; border-radius: 50%; background: currentColor; box-shadow: 0 0 0 2px color-mix(in srgb, currentColor 22%, transparent); }
.utb-mode[data-mode="agent"] .utb-dot { animation: utb-pulse 1.4s ease-in-out infinite; }
@keyframes utb-pulse { 0%, 100% { opacity: 1; } 50% { opacity: .35; } }
.utb-sep { width: 1px; height: 11px; flex: 0 0 auto; background: var(--dsw-alias-border-l1); }
.utb-perf { flex: 0 0 auto; font-variant-numeric: tabular-nums; color: var(--dsw-alias-label-secondary); }
.utb-gap { flex: 1 1 auto; min-width: 8px; }
.utb-activity { flex: 0 1 auto; min-width: 0; max-width: 62%; overflow: hidden; white-space: nowrap; text-overflow: ellipsis; color: var(--dsw-alias-label-secondary); }
@media (prefers-reduced-motion: reduce) { .utb-mode[data-mode="agent"] .utb-dot { animation: none; } }
.utb-menu-row.utb-menu-row { display: flex; flex-direction: row; align-items: center; justify-content: flex-start; align-self: stretch; gap: 6px; width: 100%; min-height: 34px; margin: 0; padding: 6px 8px; font: inherit; font-size: 13px; line-height: 20px; text-align: left; color: var(--dsw-alias-label-primary); background: transparent; border: 0; border-radius: 12px; cursor: pointer; }
.utb-menu-row.utb-menu-row > span { flex: 1 1 auto; min-width: 0; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; text-align: left; }
.utb-menu-row.utb-menu-row > svg { flex: 0 0 auto; }
.utb-menu-row.utb-menu-row:hover { background: rgba(164, 183, 229, 0.14); background: color-mix(in srgb, var(--dsw-alias-label-primary) 14%, transparent); }
.utb-menu-row.utb-menu-row:focus-visible { outline: 2px solid var(--dsw-alias-brand-primary); outline-offset: -2px; }
/* 视图层没有该环境时的占位：问号图标 + 说明，不留空白面板 */
.utb-noview { flex: 1 1 auto; display: flex; flex-direction: column; align-items: center; justify-content: center; gap: 10px; padding: 24px; text-align: center; }
.utb-noview-icon { display: grid; place-items: center; width: 44px; height: 44px; border-radius: 12px; color: var(--dsw-alias-label-tertiary); background: color-mix(in srgb, var(--dsw-alias-label-primary) 6%, transparent); }
.utb-noview-text { display: flex; flex-direction: column; gap: 4px; font-size: 12px; line-height: 18px; }
.utb-noview-text strong { font-size: 13px; color: var(--dsw-alias-label-primary); }
.utb-noview-text p { margin: 0; color: var(--dsw-alias-label-tertiary); }

`;

    function IconBrowser({ size = 16 }) {
      return h('svg', { width: size, height: size, viewBox: '0 0 24 24', fill: 'none', stroke: 'currentColor', strokeWidth: 1.7, strokeLinecap: 'round', strokeLinejoin: 'round', 'aria-hidden': true },
        h('rect', { x: 3, y: 4.5, width: 18, height: 15, rx: 2.5 }),
        h('path', { d: 'M3 9h18M6.2 6.9h.01M9 6.9h.01' }));
    }
    function IconArrow({ dir }) {
      const d = dir === 'back' ? 'M14.5 5.5 8 12l6.5 6.5' : 'M9.5 5.5 16 12l-6.5 6.5';
      return h('svg', { width: 16, height: 16, viewBox: '0 0 24 24', fill: 'none', stroke: 'currentColor', strokeWidth: 1.9, strokeLinecap: 'round', strokeLinejoin: 'round', 'aria-hidden': true }, h('path', { d }));
    }
    function IconReload() {
      return h('svg', { width: 16, height: 16, viewBox: '0 0 24 24', fill: 'none', stroke: 'currentColor', strokeWidth: 1.8, strokeLinecap: 'round', strokeLinejoin: 'round', 'aria-hidden': true },
        h('path', { d: 'M19.5 12a7.5 7.5 0 1 1-2.6-5.7' }), h('path', { d: 'M19.8 4.6v4.2h-4.2' }));
    }
    /** 尺寸调整：视口/响应式（四角 + 内部视口）。 */
    function IconSize() {
      return h('svg', { width: 16, height: 16, viewBox: '0 0 24 24', fill: 'none', stroke: 'currentColor', strokeWidth: 1.7, strokeLinecap: 'round', strokeLinejoin: 'round', 'aria-hidden': true },
        h('path', { d: 'M4.2 8.6V5.4a1.2 1.2 0 0 1 1.2-1.2h3.2' }),
        h('path', { d: 'M15.4 4.2h3.2a1.2 1.2 0 0 1 1.2 1.2v3.2' }),
        h('path', { d: 'M19.8 15.4v3.2a1.2 1.2 0 0 1-1.2 1.2h-3.2' }),
        h('path', { d: 'M8.6 19.8H5.4a1.2 1.2 0 0 1-1.2-1.2v-3.2' }),
        h('rect', { x: 8.6, y: 8.6, width: 6.8, height: 6.8, rx: 1.4 }));
    }
    /** 标注：画笔（用户 2026-11-02 要求，入口图标）。 */
    function IconAnnot() {
      return h('svg', { width: 16, height: 16, viewBox: '0 0 24 24', fill: 'none', stroke: 'currentColor', strokeWidth: 1.7, strokeLinecap: 'round', strokeLinejoin: 'round', 'aria-hidden': true },
        h('path', { d: 'M15.6 4.4a1.9 1.9 0 0 1 2.7 2.7L8.9 16.5l-4.2 1.5 1.5-4.2Z' }),
        h('path', { d: 'm13.8 6.2 3.2 3.2' }));
    }
    /** 标注子工具的小图标（16×16、currentColor、stroke 1.7）。 */
    function IconAnnotTool({ tool }) {
      const svg = (children) => h('svg', { width: 16, height: 16, viewBox: '0 0 24 24', fill: 'none', stroke: 'currentColor', strokeWidth: 1.7, strokeLinecap: 'round', strokeLinejoin: 'round', 'aria-hidden': true }, children);
      // 选择：鼠标指针箭头（白芯描边，和十字形的绘制工具区分开）。
      if (tool === 'select') return svg(h('path', { d: 'M6.2 3.8v14.2l3.8-3.5 2.5 5.2 2.6-1.2-2.5-5.2 5-.5Z' }));
      // 框选：虚线矩形（与实线「矩形」绘制工具同尺寸，靠虚线区分）。
      if (tool === 'marquee') return svg(h('rect', { x: 4.5, y: 5.5, width: 15, height: 13, rx: 1.2, strokeDasharray: '2.6 2.4' }));
      if (tool === 'circle') return svg(h('circle', { cx: 12, cy: 12, r: 7 }));
      if (tool === 'rect') return svg(h('rect', { x: 4.5, y: 5.5, width: 15, height: 13, rx: 1.2 }));
      if (tool === 'line') return svg(h('path', { d: 'M5.5 18.5 18.5 5.5' }));
      if (tool === 'arrow') return svg([h('path', { key: 'shaft', d: 'M5.5 18.5 17.4 6.6' }), h('path', { key: 'head', d: 'M11.6 6.2h6.6v6.6' })]);
      if (tool === 'brush') return svg([h('path', { key: 'body', d: 'M15.6 4.4a1.9 1.9 0 0 1 2.7 2.7L8.9 16.5l-4.2 1.5 1.5-4.2Z' }), h('path', { key: 'tip', d: 'm13.8 6.2 3.2 3.2' })]);
      // 橡皮擦（v2，§11.4）：16×16、currentColor、1.7 描边。
      if (tool === 'eraser') return svg([
        h('path', { key: 'body', d: 'M10.4 19.8 4.6 14a1.7 1.7 0 0 1 0-2.4l7.2-7.2a1.7 1.7 0 0 1 2.4 0l4.3 4.3a1.7 1.7 0 0 1 0 2.4l-9.1 9.1Z' }),
        h('path', { key: 'seam', d: 'm9.4 8.7 6.7 6.7' }),
        h('path', { key: 'tray', d: 'M9.2 19.8H19.4' }),
      ]);
      return svg([h('path', { key: 'top', d: 'M5 6.5h14' }), h('path', { key: 'stem', d: 'M12 6.5v11' }), h('path', { key: 'base', d: 'M9 17.5h6' })]);
    }
    function IconInspect() {
      return h('svg', { width: 16, height: 16, viewBox: '0 0 24 24', fill: 'none', stroke: 'currentColor', strokeWidth: 1.6, strokeLinecap: 'round', strokeLinejoin: 'round', 'aria-hidden': true },
        h('path', { d: 'M4 9V6.6C4 5.2 5.2 4 6.6 4H9M15 4h2.4C18.8 4 20 5.2 20 6.6V9M4 15v2.4C4 18.8 5.2 20 6.6 20H9', strokeDasharray: '2.6 2.2' }),
        h('path', { d: 'm12.4 10.6 2.9 8.6 1.6-3.4 3.5-1.4-8-3.8Z', fill: 'currentColor', strokeWidth: 0 }));
    }
    function IconChevron() {
      return h('svg', { width: 12, height: 12, viewBox: '0 0 24 24', fill: 'none', stroke: 'currentColor', strokeWidth: 2, strokeLinecap: 'round', strokeLinejoin: 'round', 'aria-hidden': true }, h('path', { d: 'm6 9 6 6 6-6' }));
    }
    function IconWindow() {
      return h('svg', { width: 18, height: 18, viewBox: '0 0 24 24', fill: 'none', stroke: 'currentColor', strokeWidth: 1.7, strokeLinecap: 'round', strokeLinejoin: 'round', 'aria-hidden': true },
        h('rect', { x: 3, y: 5, width: 18, height: 14, rx: 2.5 }),
        h('path', { d: 'M3 9.5h18' }),
        h('path', { d: 'M6.3 7.3h.01M8.8 7.3h.01' }));
    }
    /** 地址栏历史：时钟箭头（点击展开最近访问）。 */
    function IconHistory() {
      return h('svg', { width: 14, height: 14, viewBox: '0 0 24 24', fill: 'none', stroke: 'currentColor', strokeWidth: 1.8, strokeLinecap: 'round', strokeLinejoin: 'round', 'aria-hidden': true },
        h('path', { d: 'M3.5 12a8.5 8.5 0 1 0 2.6-6.1' }), h('path', { d: 'M3.2 4.4v4.2h4.2' }), h('path', { d: 'M12 8.2V12l2.9 1.8' }));
    }
    /** 转到：右箭头 + 落点竖线（等同回车跳转地址）。 */
    function IconGo() {
      return h('svg', { width: 16, height: 16, viewBox: '0 0 24 24', fill: 'none', stroke: 'currentColor', strokeWidth: 1.9, strokeLinecap: 'round', strokeLinejoin: 'round', 'aria-hidden': true },
        h('path', { d: 'M4.5 12h12' }), h('path', { d: 'm12.2 7.4 4.6 4.6-4.6 4.6' }), h('path', { d: 'M19.6 6.4v11.2' }));
    }
    function IconMore() {
      return h('svg', { width: 16, height: 16, viewBox: '0 0 24 24', fill: 'currentColor', 'aria-hidden': true },
        h('circle', { cx: 5.5, cy: 12, r: 1.5 }), h('circle', { cx: 12, cy: 12, r: 1.5 }), h('circle', { cx: 18.5, cy: 12, r: 1.5 }));
    }

    /* ------------------------------------------------------------------------------------------
     * Preview frame transport.
     *
     * Capture stays in the Host (CDP Page.startScreencast). This layer only receives the newest
     * frame and reports measured timing:
     *   - preferred: same-origin WebSocket `/plugins/ui-testing/frames` (server push, binary JPEG)
     *   - fallback : existing `GET /frame?since=N` polling (compatibility path)
     *
     * Wire format for the WebSocket: text hello, then binary [uint32BE metaLen][JSON meta][JPEG].
     * Polling responses carry the same metadata fields (seq/epoch/capturedAt/width/height).
     * The transport is deliberately UI-free; React only subscribes to frames/states.
     * ---------------------------------------------------------------------------------------- */
    const FRAME_POLL_MS = 80;
    const WS_RETRY_MIN_MS = 800;
    const WS_RETRY_MAX_MS = 15000;
    const WS_OPEN_TIMEOUT_MS = 4000;
    const SEED_DELAY_MS = 700;
    const SEED_DEBOUNCE_MS = 200;
    /** How long a canvas barrier must stay mismatched before the client refreshes the PNG seed. */
    const SEED_STALE_MS = 650;
    /**
     * Barrier reasons that may legitimately be repaired by one bounded composed-seed request.
     * `frame-scroll-missing` / `no-frame` are new: without them a live page whose frame lost its
     * scroll metadata stayed fail-closed forever. A request is only made while a target is running.
     */
    const SEED_REFRESH_REASONS = new Set([
      'page-size-mismatch', 'scroll-mismatch', 'seed-stale', 'seed-provenance-missing',
      'frame-scroll-missing', 'no-frame',
    ]);

    function frameSocketUrl(scope) {
      const scheme = location.protocol === 'https:' ? 'wss:' : 'ws:';
      let query = '?scopeVersion=' + SCOPE_VERSION;
      if (scope && scope.kind === 'session' && scope.sessionId) query += '&sessionId=' + encodeURIComponent(scope.sessionId) + '&tab=primary';
      else if (scope && scope.binding) query += '&binding=' + encodeURIComponent(scope.binding);
      else query += '&scope=recent';
      return scheme + '//' + location.host + HOST_BASE + '/frames' + query;
    }

    function blobFromBase64(base64, type) {
      const binary = atob(base64 || '');
      const bytes = new Uint8Array(binary.length);
      for (let index = 0; index < binary.length; index += 1) bytes[index] = binary.charCodeAt(index);
      return new Blob([bytes], { type: type || 'image/jpeg' });
    }

    function parsePushedFrame(buffer) {
      if (!buffer || buffer.byteLength < 5) return null;
      const view = new DataView(buffer);
      const headerLength = view.getUint32(0);
      if (!headerLength || headerLength > buffer.byteLength - 4) return null;
      const header = JSON.parse(new TextDecoder().decode(new Uint8Array(buffer, 4, headerLength)));
      if (!header || header.v !== 1) return null;
      return { meta: header, blob: new Blob([buffer.slice(4 + headerLength)], { type: 'image/jpeg' }) };
    }

    /**
     * @param {{onFrame: (frame: {blob: Blob, meta: object}) => void,
     *          onState: (state: object) => void,
     *          onTransport: (kind: 'ws'|'poll') => void,
     *          canWrite?: () => boolean}} handlers
     * @param {object} scope Immutable scope/binding snapshot for every request and the WS.
     */
    function createFrameTransport(handlers, scope) {
      let closed = false;
      const controller = typeof AbortController === 'function' ? new AbortController() : null;
      const signal = controller ? controller.signal : undefined;
      let socket;
      let socketTimer = 0;
      let pollTimer = 0;
      let pollBusy = false;
      let retryTimer = 0;
      let retryDelay = WS_RETRY_MIN_MS;
      let kind = 'poll';
      let lastSeq = -1;
      let lastEpoch = -1;
      let lastState;
      let urlSince = 0;
      // PNG seed state (see the seed block below): signature of the last requested shell state and
      // a bounded diagnostic counter set. `seedStats` is evidence-only and never an assertion.
      let seedContext = null;
      let seedKey = '';
      let seedRequestedKey = '';
      let seedScheduledKey = '';
      let seedScheduledForce = false;
      let seedForceKey = '';
      let seedWarnedKey = '';
      let seedPending = false;
      let seedTimer = 0;
      let lastManualSeedAt = 0;
      const seedStats = { requested: 0, accepted: 0, stale: 0, invalid: 0, failed: 0, forced: 0, manual: 0 };
      const stats = {
        transport: 'poll',
        received: 0,
        droppedClient: 0,
        transportMs: 0,
        seeded: 0,
        lastMeta: null,
        hostDropped: null,
      };

      function emitTransport() {
        stats.transport = kind;
        try { handlers.onTransport(kind); } catch { /* UI must not break transport */ }
      }

      function accept(meta, blob) {
        const seq = Number(meta && meta.seq);
        const epoch = Number(meta && meta.epoch);
        if (Number.isFinite(epoch) && epoch < lastEpoch) {
          stats.droppedClient += 1;
          return;
        }
        if (Number.isFinite(epoch) && epoch === lastEpoch && Number.isFinite(seq) && seq <= lastSeq) return;
        if (Number.isFinite(epoch) && epoch === lastEpoch && Number.isFinite(seq) && lastSeq >= 0 && seq > lastSeq + 1) {
          stats.droppedClient += seq - lastSeq - 1;
        }
        if (Number.isFinite(seq)) lastSeq = seq;
        if (Number.isFinite(epoch)) lastEpoch = Math.max(lastEpoch, epoch);
        stats.received += 1;
        if (Number(meta && meta.capturedAtMs) > 0) {
          stats.transportMs = Math.max(0, Date.now() - Number(meta.capturedAtMs));
        }
        stats.lastMeta = meta || null;
        if (meta && meta.dropped) stats.hostDropped = meta.dropped;
        try { handlers.onFrame({ blob, meta: meta || {} }); } catch { /* ignore */ }
      }

      function noteState(state) {
        if (!state || closed) return;
        if (!lastState || lastState.url !== state.url) {
          lastState = state;
          urlSince = Date.now();
        } else {
          lastState = state;
        }
        scheduleSeed();
      }

      /* ---- PNG seed for static pages (no screencast damage after load) ------------------------
       *
       * A seed is a /screenshot of the current canvas view. On a canvas Host it must be provably
       * composited at the C/S/revision/scale it was requested for (docs/viewport-control.md);
       * the React side publishes `updateSeedContext()` on every accepted state and the transport
       * refreshes the seed when that context moves. Same shell state is requested at most once; an
       * incomplete response or a stale capture is dropped and leaves canvas input fail-closed.
       * -------------------------------------------------------------------------------------- */

      function seedKeyOf(context) {
        if (!context) return '';
        const url = String(context.url || (lastState && lastState.url) || '');
        if (context.legacy) return 'legacy|' + url;
        const round = (value) => (Number.isFinite(Number(value)) ? Math.round(Number(value) * 100) / 100 : null);
        return [
          url,
          round(context.canvasX), round(context.canvasY),
          round(context.scrollX), round(context.scrollY),
          Number.isFinite(Number(context.viewRevision)) ? Number(context.viewRevision) : null,
          round(context.scale),
          round(context.width), round(context.height),
        ].join('|');
      }

      /** Publish the shell canvas/scroll/scale signature; called after every accepted snapshot. */
      function updateSeedContext(context) {
        if (closed) return;
        seedContext = context || null;
        if (!seedContext) return;
        seedKey = seedKeyOf(seedContext);
        if (seedForceKey && seedForceKey !== seedKey) seedForceKey = '';
        scheduleSeed();
      }

      /**
       * React asks for a fresh composed seed after a sustained barrier mismatch (page-size / scroll /
       * seed-stale / missing frame evidence). This may run even after live frames were received.
       */
      function requestSeedRefresh(context) {
        if (closed || !context) return;
        seedContext = context;
        seedKey = seedKeyOf(context);
        seedForceKey = seedKey;
        scheduleSeed();
      }

      /**
       * Explicit user "retry sync": the one automatic attempt per shell signature is cleared, but
       * the request stays single-flight and throttled. This never invents a view revision or writes
       * Runtime lastError.
       */
      function retrySeedRefresh(context) {
        if (closed || !context) return false;
        const now = Date.now();
        if (now - lastManualSeedAt < 1000) return false;
        lastManualSeedAt = now;
        seedContext = context;
        seedKey = seedKeyOf(context);
        seedRequestedKey = '';
        seedWarnedKey = '';
        seedForceKey = seedKey;
        seedStats.manual += 1;
        scheduleSeed();
        return true;
      }

      function notifySeedStatus(status) {
        try { if (handlers.onSeedStatus) handlers.onSeedStatus(status); } catch { /* UI must not break transport */ }
      }

      function warnSeed(reason) {
        notifySeedStatus({ state: 'failed', reason });
        if (seedWarnedKey === seedRequestedKey) return;
        seedWarnedKey = seedRequestedKey;
        console.warn('ui-testing: seed screenshot rejected (' + reason + '); canvas input stays fail-closed');
      }

      function scheduleSeed() {
        if (closed || !seedContext || !seedKey) return;
        const force = seedForceKey === seedKey;
        // The historical seed only applies before the first live frame; a React-driven refresh is
        // allowed after live frames when the displayed frame can no longer prove the canvas.
        if (!force && stats.received > 0) return;
        if (handlers.canWrite && !handlers.canWrite()) return;
        if (seedRequestedKey === seedKey) { if (force) seedForceKey = ''; return; } // one attempt per shell state
        if (seedPending) return; // the completion schedules the latest pending signature
        if (seedTimer && seedScheduledKey === seedKey) return; // do not restart our own debounce
        if (seedTimer) window.clearTimeout(seedTimer);
        // A URL change keeps the historical settle delay; later canvas/scroll moves use a short
        // debounce so a drag does not request a composition per pointer move.
        const sinceUrl = Date.now() - urlSince;
        const delay = Math.max(SEED_DEBOUNCE_MS, sinceUrl < SEED_DELAY_MS ? SEED_DELAY_MS - sinceUrl : 0);
        seedScheduledKey = seedKey;
        seedScheduledForce = force;
        seedTimer = window.setTimeout(() => {
          seedTimer = 0;
          seedScheduledKey = '';
          requestSeed(seedScheduledForce);
          seedScheduledForce = false;
        }, delay);
      }

      /** Extract the composited-at-canvas provenance from /screenshot; null when insufficient. */
      function seedFactsFrom(payload) {
        if (!payload || !payload.image) return null;
        const object = (value) => (value && typeof value === 'object' ? value : null);
        const view = object(payload.view) || object(payload.state && payload.state.ui && payload.state.ui.view);
        const capture = object(payload.capture);
        const mapping = object(payload.mapping) || object(capture && capture.mapping);
        const canvas = object(payload.canvas) || object(capture && capture.canvas) || object(mapping && mapping.canvas);
        const viewport = object(capture && capture.viewport) || object(payload.viewport);
        const mappingScroll = object(mapping && mapping.scrollAtCapture);
        const num = (value) => (value === null || value === undefined || value === '' ? null : (Number.isFinite(Number(value)) ? Number(value) : null));
        // Capture-time evidence wins over the current view projection (the latter may have advanced
        // between the request and the capture). Missing evidence is never replaced by an assumption.
        const canvasX = num(canvas && canvas.x) ?? num(view && view.canvasX);
        const canvasY = num(canvas && canvas.y) ?? num(view && view.canvasY);
        const scrollX = num(canvas && canvas.scrollX) ?? num(view && view.x) ?? num(mappingScroll && mappingScroll.x);
        const scrollY = num(canvas && canvas.scrollY) ?? num(view && view.y) ?? num(mappingScroll && mappingScroll.y);
        const viewRevision = num(capture && capture.viewRevision) ?? num(view && view.revision) ?? num(payload.viewRevision);
        const scale = num(capture && capture.requestedScale) ?? num(view && view.scale) ?? num(payload.scale);
        const width = num(viewport && viewport.width) ?? num(view && view.width) ?? num(payload.width);
        const height = num(viewport && viewport.height) ?? num(view && view.height) ?? num(payload.height);
        // Content box is optional for the barrier but needed to clip a composed seed so the panel
        // can show its checkerboard instead of the Host's evidence-white blank.
        const contentWidth = num(canvas && canvas.contentWidth) ?? num(mapping && mapping.canvas && mapping.canvas.contentWidth);
        const contentHeight = num(canvas && canvas.contentHeight) ?? num(mapping && mapping.canvas && mapping.canvas.contentHeight);
        if ([canvasX, canvasY, scrollX, scrollY, viewRevision, scale, width, height].some((value) => value === null)) return null;
        return { canvasX, canvasY, scrollX, scrollY, viewRevision, scale, width, height, contentWidth, contentHeight };
      }

      function seedFactsMatch(facts, context) {
        if (!facts || !context || context.legacy) return false;
        const near = (a, b, tolerance) => Number.isFinite(Number(a)) && Number.isFinite(Number(b)) && Math.abs(Number(a) - Number(b)) <= tolerance;
        return near(facts.canvasX, context.canvasX, 1)
          && near(facts.canvasY, context.canvasY, 1)
          && near(facts.scrollX, context.scrollX, 1)
          && near(facts.scrollY, context.scrollY, 1)
          && Number(facts.viewRevision) === Number(context.viewRevision)
          && near(facts.scale, context.scale, 0.001)
          && near(facts.width, context.width, 1)
          && near(facts.height, context.height, 1);
      }

      function requestSeed(force) {
        if (closed || !seedContext || !seedKey) return;
        if (!force && stats.received > 0) return;
        if (seedRequestedKey === seedKey || seedPending) return;
        if (handlers.canWrite && !handlers.canWrite()) return;
        if (seedForceKey === seedKey) seedForceKey = '';
        const requestedKey = seedKey;
        const requestedContext = seedContext;
        seedRequestedKey = requestedKey;
        seedPending = true;
        seedStats.requested += 1;
        if (force) seedStats.forced += 1;
        // A canvas seed must be composed at C (docs/viewport-control.md); an old Host keeps the
        // historical plain-page screenshot request.
        callHost('screenshot', requestedContext.legacy ? {} : { canvas: true }, { scope, signal }).then((payload) => {
          if (closed) return;
          if (!payload || !payload.image) {
            // The page is intentionally closed (empty tab state): no seed, no error, no page start.
            if (payload && payload.closed === true) return;
            seedStats.failed += 1;
            warnSeed('no-image');
            return;
          }
          if (requestedContext.legacy) {
            // Historical plain-page seed (old Host / no canvas): no canvas provenance to claim.
            const meta = {
              seed: true,
              seq: 0,
              epoch: lastEpoch < 0 ? 0 : lastEpoch,
              capturedAtMs: payload.capturedAt,
              width: payload.viewport && payload.viewport.width,
              height: payload.viewport && payload.viewport.height,
              pageWidth: payload.viewport && payload.viewport.width,
              pageHeight: payload.viewport && payload.viewport.height,
            };
            stats.seeded += 1;
            stats.lastMeta = meta;
            notifySeedStatus({ state: 'ok', reason: null });
            try { handlers.onFrame({ blob: blobFromBase64(payload.image, 'image/png'), meta }); } catch { /* UI must not break transport */ }
            return;
          }
          const facts = seedFactsFrom(payload);
          if (!facts) { seedStats.invalid += 1; warnSeed('provenance-missing'); return; }
          // The response is only usable while the shell is still on the exact signature requested,
          // and the Host must prove it composited at that same C/S/revision/scale.
          if (!seedContext || requestedKey !== seedKeyOf(seedContext)) { seedStats.stale += 1; return; }
          if (!seedFactsMatch(facts, requestedContext)) { seedStats.invalid += 1; warnSeed('provenance-mismatch'); return; }
          const meta = {
            seed: true,
            // The PNG is the canvas view (composited at C or the O=0 single native capture): the
            // client must not apply the live-frame displacement on top of it.
            seedComposite: true,
            seq: 0,
            epoch: lastEpoch < 0 ? 0 : lastEpoch,
            capturedAtMs: payload.capturedAt,
            width: facts.width,
            height: facts.height,
            pageWidth: facts.width,
            pageHeight: facts.height,
            // The seed image is already composited at C: the preview must not translate it, but the
            // barrier compares these facts with the live C/S/revision to refuse stale pixels.
            seedCanvasX: facts.canvasX,
            seedCanvasY: facts.canvasY,
            seedScrollX: facts.scrollX,
            seedScrollY: facts.scrollY,
            seedViewRevision: facts.viewRevision,
            seedScale: facts.scale,
            seedWidth: facts.width,
            seedHeight: facts.height,
            seedContentWidth: facts.contentWidth,
            seedContentHeight: facts.contentHeight,
          };
          stats.seeded += 1;
          seedStats.accepted += 1;
          stats.lastMeta = meta;
          notifySeedStatus({ state: 'ok', reason: null });
          try { handlers.onFrame({ blob: blobFromBase64(payload.image, 'image/png'), meta }); } catch { /* UI must not break transport */ }
        }).catch((error) => {
          if (error && error.name === 'AbortError') return;
          seedStats.failed += 1;
          notifySeedStatus({ state: 'failed', reason: 'request-failed' });
        }).finally(() => {
          seedPending = false;
          if (closed) return;
          // A context change while the request was in flight gets exactly one follow-up request;
          // outside the initial seed this only happens when React flagged the new key for refresh.
          if (seedKey && seedRequestedKey !== seedKey && (stats.received === 0 || seedForceKey === seedKey)) scheduleSeed();
        });
      }

      function stopPolling() {
        if (pollTimer) window.clearTimeout(pollTimer);
        pollTimer = 0;
      }

      async function pollOnce() {
        pollTimer = 0;
        if (closed || kind === 'ws' || pollBusy) return;
        pollBusy = true;
        try {
          const response = await fetch(HOST_BASE + '/frame?since=' + Math.max(0, lastSeq), { credentials: 'same-origin', headers: scopeHeaders(scope), signal });
          if (response.ok) {
            const payload = await response.json();
            if (payload.state) {
              // The transport only ever needs the redacted url (seed decision): the raw address
              // never enters transport state, metrics or error text.
              noteState({ url: payload.state.url });
              try { handlers.onState(payload.state); } catch { /* ignore */ }
            }
            if (!payload.pending && payload.image) {
              const epoch = Number(payload.epoch) || 0;
              const seq = Number(payload.seq) || 0;
              if (epoch > lastEpoch || (epoch === lastEpoch && seq > lastSeq)) {
                accept({
                  seq,
                  epoch,
                  transport: 'poll',
                  capturedAtMs: payload.capturedAt,
                  receivedAtMs: payload.receivedAt,
                  width: payload.width,
                  height: payload.height,
                  pageWidth: payload.pageWidth,
                  pageHeight: payload.pageHeight,
                  // P0-C v2 frame metadata (docs/viewport-control.md): the capture-time top-level
                  // scroll, needed to composite the canvas view and to prove input freshness.
                  scrollX: payload.scrollX,
                  scrollY: payload.scrollY,
                  format: 'jpeg',
                }, blobFromBase64(payload.image, 'image/jpeg'));
              }
            }
          }
        } catch { /* runtime not started or transient network error */ }
        pollBusy = false;
        if (!closed && kind !== 'ws') {
          scheduleSeed();
          pollTimer = window.setTimeout(pollOnce, FRAME_POLL_MS);
        }
      }

      function startPolling() {
        if (closed || kind === 'ws' || pollBusy || pollTimer) return;
        pollTimer = window.setTimeout(pollOnce, 0);
      }

      function scheduleRetry() {
        if (closed) return;
        if (retryTimer) window.clearTimeout(retryTimer);
        retryTimer = window.setTimeout(() => {
          retryTimer = 0;
          connectSocket();
        }, retryDelay);
        retryDelay = Math.min(WS_RETRY_MAX_MS, Math.round(retryDelay * 1.8));
      }

      function connectSocket() {
        if (closed) return;
        let next;
        try {
          next = new WebSocket(frameSocketUrl(scope));
          next.binaryType = 'arraybuffer';
        } catch { scheduleRetry(); return; }
        socket = next;
        socketTimer = window.setTimeout(() => {
          if (socket === next && next.readyState === 0) {
            try { next.close(); } catch { /* ignore */ }
          }
        }, WS_OPEN_TIMEOUT_MS);
        next.onopen = () => {
          if (closed || socket !== next) return;
          window.clearTimeout(socketTimer);
          socketTimer = 0;
          retryDelay = WS_RETRY_MIN_MS;
          kind = 'ws';
          emitTransport();
          stopPolling();
        };
        next.onmessage = (event) => {
          if (closed || socket !== next) return;
          if (typeof event.data === 'string') {
            try {
              const message = JSON.parse(event.data);
              if (message && message.type === 'hello') {
                kind = 'ws';
                emitTransport();
              }
            } catch { /* ignore malformed control message */ }
            return;
          }
          try {
            const parsed = parsePushedFrame(event.data);
            if (parsed) {
              kind = 'ws';
              accept(parsed.meta, parsed.blob);
            }
          } catch { /* ignore malformed binary frame */ }
        };
        next.onerror = () => {
          if (socket === next) {
            try { next.close(); } catch { /* ignore */ }
          }
        };
        next.onclose = () => {
          window.clearTimeout(socketTimer);
          socketTimer = 0;
          if (socket === next) socket = undefined;
          if (closed) return;
          if (kind === 'ws') {
            kind = 'poll';
            emitTransport();
          }
          startPolling();
          scheduleRetry();
        };
      }

      return {
        start() {
          connectSocket();
          startPolling();
        },
        close() {
          closed = true;
          if (controller) {
            try { controller.abort(); } catch { /* ignore */ }
          }
          window.clearTimeout(socketTimer);
          window.clearTimeout(retryTimer);
          if (seedTimer) window.clearTimeout(seedTimer);
          socketTimer = 0;
          retryTimer = 0;
          seedTimer = 0;
          stopPolling();
          if (socket) {
            try { socket.close(); } catch { /* ignore */ }
            socket = undefined;
          }
        },
        noteState,
        updateSeedContext,
        requestSeedRefresh,
        retrySeedRefresh,
        stats() {
          return {
            transport: kind,
            received: stats.received,
            droppedClient: stats.droppedClient,
            transportMs: stats.transportMs,
            seeded: stats.seeded,
            lastSeq,
            lastEpoch,
            lastMeta: stats.lastMeta,
            hostDropped: stats.hostDropped,
            seed: { ...seedStats },
          };
        },
      };
    }

    /* ------------------------------------------------------------------------------------------
     * Workspace scope binding for the panel.
     *
     * The right sidebar tab is session-scoped and receives the standard `sessionId` prop. The
     * root-scoped main panel has no Session binding: `MoreRow` remembers the session that owns the
     * main view right before `layout.selectPanel`, and `DebugView` reads that memory. With no
     * capture the panel asks the Host for `recent` once, then pins every request/WS to the Host
     * provided runtime binding so a later request cannot drift to another workspace.
     * ---------------------------------------------------------------------------------------- */
    const MAIN_CAPTURE_NONE = '!none';
    const MAIN_CAPTURE_LOADING = '!loading';
    const MAIN_CAPTURE_AMBIGUOUS = '!ambiguous';

    const mainCapture = { sessionId: '', resolution: 'none' };
    const mainCaptureListeners = new Set();

    function parseCaptureValue(value) {
      const text = typeof value === 'string' ? value : MAIN_CAPTURE_NONE;
      if (text === MAIN_CAPTURE_LOADING) return { sessionId: '', resolution: 'loading' };
      if (text === MAIN_CAPTURE_AMBIGUOUS) return { sessionId: '', resolution: 'ambiguous' };
      if (text.indexOf('session:') === 0) {
        const sessionId = text.slice('session:'.length);
        return sessionId ? { sessionId, resolution: 'session' } : { sessionId: '', resolution: 'none' };
      }
      return { sessionId: '', resolution: 'none' };
    }

    function rememberMainCapture(value) {
      const next = parseCaptureValue(value);
      if (next.sessionId === mainCapture.sessionId && next.resolution === mainCapture.resolution) return;
      mainCapture.sessionId = next.sessionId;
      mainCapture.resolution = next.resolution;
      for (const listener of mainCaptureListeners) {
        try { listener(); } catch { /* a listener must not break the capture */ }
      }
    }

    function useMainCapture() {
      const [, bump] = React.useReducer((value) => value + 1, 0);
      React.useEffect(() => {
        mainCaptureListeners.add(bump);
        return () => { mainCaptureListeners.delete(bump); };
      }, []);
      return mainCapture;
    }

    /** Primitive selector for the standard `useSessions` hook (stable across renders). */
    function mainViewCaptureSelector(state) {
      if (!state || state.phase !== 'ready') return MAIN_CAPTURE_LOADING;
      const byId = state.byId || {};
      const ids = Array.isArray(state.ids) && state.ids.length ? state.ids : Object.keys(byId);
      let found = '';
      let count = 0;
      for (const id of ids) {
        const row = byId[id];
        const retained = row && row.retainedBy && Number(row.retainedBy.mainView) > 0;
        if (!retained) continue;
        count += 1;
        found = id;
        if (count > 1) return MAIN_CAPTURE_AMBIGUOUS;
      }
      return count === 1 ? 'session:' + found : MAIN_CAPTURE_NONE;
    }

    function parseLiveCapture(value) {
      const text = typeof value === 'string' ? value : MAIN_CAPTURE_NONE;
      if (text === MAIN_CAPTURE_LOADING) return { kind: 'loading', sessionId: '' };
      if (text === MAIN_CAPTURE_AMBIGUOUS) return { kind: 'ambiguous', sessionId: '' };
      if (text.indexOf('session:') === 0) return { kind: 'session', sessionId: text.slice('session:'.length) };
      return { kind: 'none', sessionId: '' };
    }

    /**
     * Main-panel identity: the capture memory wins (the panel is pinned when it opens); a unique
     * live main view resolves an earlier loading/ambiguous capture. Ambiguity only pauses writes.
     */
    function resolvePanelIdentity(seatSessionId, capture, liveValue) {
      if (seatSessionId) {
        return { kind: 'session', sessionId: seatSessionId, key: 'session:' + seatSessionId, paused: false };
      }
      const live = parseLiveCapture(liveValue);
      let sessionId = capture && capture.sessionId ? capture.sessionId : '';
      let resolved = capture && capture.resolution ? capture.resolution : 'none';
      if (resolved !== 'session' && live.kind === 'session' && live.sessionId) {
        sessionId = live.sessionId;
        resolved = 'session';
      }
      const paused = live.kind === 'loading' || live.kind === 'ambiguous';
      if (resolved === 'session' && sessionId) return { kind: 'session', sessionId, key: 'session:' + sessionId, paused };
      return { kind: 'recent', sessionId: '', key: 'recent', paused };
    }

    function useDocumentVisibility() {
      const [visible, setVisible] = React.useState(() => (typeof document === 'undefined' ? true : document.visibilityState !== 'hidden'));
      React.useEffect(() => {
        if (typeof document === 'undefined') return undefined;
        const update = () => setVisible(document.visibilityState !== 'hidden');
        document.addEventListener('visibilitychange', update);
        update();
        return () => document.removeEventListener('visibilitychange', update);
      }, []);
      return visible;
    }

    /** Slot dispatcher: the sidebar tab seat has useTabInfo; the root main seat does not. */
    function DebugView(props) {
      if (props && typeof props.useTabInfo === 'function') return h(SidebarDebugView, props);
      if (props && typeof props.sessionId === 'string' && props.sessionId) return h(SessionDebugViewStatic, props);
      return h(MainDebugView, props);
    }

    function SidebarDebugView(props) {
      const info = props.useTabInfo();
      const tab = info && info.tab ? info.tab : null;
      // An older shell without tab visibility data is conservatively treated as visible.
      const visible = !tab || tab.visible !== false;
      const sessionId = typeof props.sessionId === 'string' ? props.sessionId : '';
      return h(DebugViewBody, Object.assign({}, props, { seatSessionId: sessionId, visible, capture: null, liveCapture: '' }));
    }

    function SessionDebugViewStatic(props) {
      return h(DebugViewBody, Object.assign({}, props, { seatSessionId: props.sessionId, visible: true, capture: null, liveCapture: '' }));
    }

    function MainDebugView(props) {
      const safe = props || {};
      if (typeof safe.useSessions === 'function') return h(MainDebugViewLive, safe);
      return h(MainDebugViewStatic, safe);
    }

    function MainDebugViewLive(props) {
      const liveCapture = props.useSessions(mainViewCaptureSelector);
      return h(MainDebugViewRender, Object.assign({}, props, { liveCapture }));
    }

    function MainDebugViewStatic(props) {
      return h(MainDebugViewRender, Object.assign({}, props, { liveCapture: MAIN_CAPTURE_NONE }));
    }

    function MainDebugViewRender(props) {
      const capture = useMainCapture();
      const visible = useDocumentVisibility();
      return h(DebugViewBody, Object.assign({}, props, { seatSessionId: '', visible, capture }));
    }

    /** The debug view body, shared by the main column and the right sidebar. */
    function DebugViewBody(props) {
      // `draft` is only the address-bar edit buffer: the navigation truth lives in `remote.ui`.
      const [draft, setDraft] = React.useState('');
      const [sizing, setSizing] = React.useState(false);
      const [width, setWidth] = React.useState(String(envDefaultSize('web').width));
      const [height, setHeight] = React.useState(String(envDefaultSize('web').height));
      const [posX, setPosX] = React.useState('0');
      const [posY, setPosY] = React.useState('0');
      const [fit, setFit] = React.useState(true);
      const [zoom, setZoom] = React.useState('100');
      /** 用户 2026-11-02 要求：尺寸栏的「拖拽」模式（勾选时画面变抓取手势，拖动平移视口）。 */
      const [panMode, setPanMode] = React.useState(false);
      const [panDragging, setPanDragging] = React.useState(false);
      const [room, setRoom] = React.useState({ w: 0, h: 0 });
      const [error, setError] = React.useState('');
      const [menu, setMenu] = React.useState(false);
      // Local, panel-only result of the "open DevTools" click. Never written to Runtime lastError:
      // a blocked popup is a browser decision, not a page failure.
      const [devtoolsNotice, setDevtoolsNotice] = React.useState(null);
      // Canvas sync (barrier) and input-failure feedback: panel-local only. `seedStatus` holds
      // {reason} after a rejected/failed seed so the user gets a real retry entry.
      const [syncMismatch, setSyncMismatch] = React.useState(false);
      const [seedStatus, setSeedStatus] = React.useState(null);
      const [blankHint, setBlankHint] = React.useState('');
      /**
       * 原生 <select> 的面板侧浮层。浏览器把弹层画在 UI 图层，帧里根本看不到，所以键盘可用、
       * 鼠标不可用；这里用点击点向 Host 问命中，命中 select 就在点击点画自己的列表。
       * 形状：{anchor:{x,y}, bounds:{width,height}, select:<projection>, reason:<不支持原因|null>, activeIndex}
       */
      const [selectPop, setSelectPop] = React.useState(null);
      const selectPopRef = React.useRef(null);
      selectPopRef.current = selectPop;
      const selectPopSeqRef = React.useRef(0);
      const selectPopElementRef = React.useRef(null);
      const [pageContext, setPageContext] = React.useState(null);
      const pageContextRef = React.useRef(null);
      pageContextRef.current = pageContext;
      const pageContextSeqRef = React.useRef(0);
      const pageContextElementRef = React.useRef(null);
      const inputQueueRef = React.useRef(Promise.resolve());
      const [inputNotice, setInputNotice] = React.useState('');
      const [tabNotice, setTabNotice] = React.useState('');
      const [tabOpening, setTabOpening] = React.useState(false);
      // The tab group list is cached in a ref (it must survive a transient remote=null): a local
      // prune after a Host-confirmed close needs its own render bump.
      const [, setTabsTick] = React.useState(0);
      const [pending, setPending] = React.useState(false);
      const [navBusy, setNavBusy] = React.useState(false);
      const [mode, setMode] = React.useState('idle');
      const [env, setEnv] = React.useState('web');
      // Host-backed environment selection: busy while the POST /config/select is in flight, and a
      // local failure notice that keeps the previous value (never a silent switch).
      const [envBusy, setEnvBusy] = React.useState(false);
      const [envNotice, setEnvNotice] = React.useState('');
      const [displaySwitching, setDisplaySwitching] = React.useState(false);
      const [shot, setShot] = React.useState('');
      const [remote, setRemote] = React.useState({ mode: 'idle', activity: '', url: '', running: false });
      const [transportKind, setTransportKind] = React.useState('poll');
      const [fps, setFps] = React.useState(0);
      const [frameMs, setFrameMs] = React.useState(0);
      const [activity, setActivity] = React.useState('无进行中的操作');
      const stage = React.useRef(null);
      const humanTimer = React.useRef(0);
      const shotUrlRef = React.useRef('');
      const frameMetaRef = React.useRef(new Map());
      const displayTimes = React.useRef([]);
      const displayLatencies = React.useRef([]);
      const displayedRef = React.useRef(0);
      const perfRef = React.useRef({ fps: 0, frameMs: 0 });
      const transportRef = React.useRef(null);
      // Accepted runtime snapshot + address-bar edit state. Refs are read from effects and
      // network callbacks, so a late poll can never resurrect a retired snapshot or a draft.
      const remoteRef = React.useRef(null);
      const focusedRef = React.useRef(false);
      const dirtyRef = React.useRef(false);
      const editVersionRef = React.useRef(0);
      const requestGenerationRef = React.useRef(0);
      const retiredRuntimeRef = React.useRef('');
      const pendingRef = React.useRef({ active: false, editVersion: 0, address: '' });
      // ---- Shared viewport state (Host `ui.view`) -------------------------------------------
      // The Host view is authoritative; every input below is only an edit draft. `dirty` protects
      // a field from being overwritten by the 500ms state poll while the user edits it.
      const viewRef = React.useRef(null);
      const viewMetaRef = React.useRef(null);
      const observedRef = React.useRef(null);
      // P0-C v2: the Host's canvas projection (`ui.canvas`). `canvasInfo` mirrors it into render so
      // the box background/transform/input fields react to the capability appearing or vanishing.
      const canvasRef = React.useRef(null);
      const [canvasInfo, setCanvasInfo] = React.useState(null);
      // A sustained canvas-barrier mismatch asks the transport for a fresh composed PNG seed; the
      // attempt key prevents a screenshot loop for one shell state.
      const seedRefreshTimerRef = React.useRef(0);
      const seedCheckKeyRef = React.useRef('');
      const seedAttemptKeyRef = React.useRef('');
      // Local canvas sync / input status (never written to Runtime lastError).
      const mismatchSinceRef = React.useRef(0);
      const blankHintTimerRef = React.useRef(0);
      const inputNoticeTimerRef = React.useRef(0);
      const tabNoticeTimerRef = React.useRef(0);
      const inputErrorAtRef = React.useRef(0);
      // A frame's scroll metadata only lands in the ref on load; this bump re-renders the preview
      // with the new displacement (the displayed frame itself is state-driven already).
      const [, setFrameVersion] = React.useState(0);
      // Shared-view presence drives the enabled/disabled X/Y + drag surfaces; a null→view (or the
      // reverse) transition must re-render even when every displayed number happens to be equal.
      const [, setViewVersion] = React.useState(0);
      // The canvas barrier depends on S/view geometry held in refs: bump a render when they move so
      // `data-utb-canvas-ready` / the composited blank state cannot go stale (input handlers always
      // recompute, but the visible surface must agree with them).
      const [, setBarrierVersion] = React.useState(0);
      // Per-field edit state: `null` = follows the Host, a number = the user's own draft value
      // (NaN for an illegible draft). Storing the value lets adoption clear the flag as soon as the
      // Host has caught up, without ever comparing against a stale render closure.
      const viewDirtyRef = React.useRef({ x: null, y: null, width: null, height: null, scale: null });
      const viewEditRef = React.useRef({ x: 0, y: 0, width: 0, height: 0, scale: 0 });
      // Edit version produced by a size-bar wheel notch per field. A rejected wheel patch must not
      // freeze the input on a value the Host never accepted (a typed draft is still preserved).
      const viewWheelRef = React.useRef({ x: 0, y: 0, width: 0, height: 0, scale: 0 });
      // Which size-bar field currently holds the caret (used by blur/commit, not by the poll).
      const viewFocusRef = React.useRef('');
      const viewFirstBindRef = React.useRef({ epoch: -1, done: false });
      const selfViewRevisionRef = React.useRef(0);
      const viewQueueRef = React.useRef(null);
      const viewTimerRef = React.useRef(0);
      const viewInFlightRef = React.useRef(false);
      const viewQueuedRef = React.useRef(null);
      // Coordinate space captured when a patch is queued (canvas vs legacy scroll). This keeps a
      // patch authored before a Host capability change from being reinterpreted at send time.
      const viewQueueSpaceRef = React.useRef(null);
      const viewQueuedSpaceRef = React.useRef(null);
      // Displayed-frame geometry: the mapping and the post-resize input barrier both read it.
      const frameGeomRef = React.useRef(null);
      const pendingGeomRef = React.useRef(null);
      const dragRef = React.useRef({ active: false, pointerId: -1, x: 0, y: 0 });
      /** 最近一次 pointerdown 的面板坐标：用来区分"点击"与"拖拽"（只有点击才弹 select 浮层）。 */
      const selectClickRef = React.useRef({ x: 0, y: 0, pointerId: -1, valid: false });
      // Host dispatches a complete right-click in one queued operation, including release.
      // P0-C「拖拽」模式：手势状态与共享 canvasX/canvasY 的节流写入（同一时刻最多一个 set 在途）。
      const panDragRef = React.useRef({
        active: false, pointerId: -1, startClientX: 0, startClientY: 0,
        startX: 0, startY: 0, geom: null, viewW: 0, viewH: 0,
      });
      const panWriteRef = React.useRef({ timer: 0, latest: null });
      const panModeRef = React.useRef(false);
      // Pan-mode wheel zoom accumulator (cursor-anchored). Keeps a short burst continuous while the
      // Host set is still in flight; a fresh window re-anchors from the accepted view/box.
      const canvasZoomRef = React.useRef({ scale: null, x: null, y: null, at: 0 });
      // A zoom patch is incremental: one revision conflict replays the same notch from the latest
      // view instead of silently dropping it.
      const zoomRetryRef = React.useRef(0);
      // The last user zoom intent survives state polls that clear the transient accumulator; it is
      // the source for burst accumulation and for the bounded CAS replay of the same notch.
      const zoomIntentRef = React.useRef({ scale: null, x: null, y: null, w: null, h: null, at: 0 });
      // Strict screen-space anchor bookkeeping: the canvas point under the cursor plus the cursor's
      // screen position, checked once after layout (one bounded C-only correction at most).
      const zoomAnchorIdRef = React.useRef(0);
      const zoomAnchorRef = React.useRef({
        id: 0, active: false, corrected: false, scheduled: false,
        d: null, screen: null, scale: null, w: null, h: null,
      });
      const [zoomAnchor, setZoomAnchor] = React.useState('screen');
      const [zoomAnchorState, setZoomAnchorState] = React.useState('idle');
      const hoverAtRef = React.useRef(0);
      const fitRef = React.useRef(true);
      const stageWheelRef = React.useRef(null);
      const sizeWheelRef = React.useRef(null);
      const frameImgRef = React.useRef(null);
      const frameBoxRef = React.useRef(null);
      const sizeBarRef = React.useRef(null);
      const annotBarRef = React.useRef(null);
      const sizingRef = React.useRef(false);
      const annotWidthWheelRef = React.useRef(null);
      // ---- P0-D 标注模式（docs/viewport-control.md）------------------------------------------
      // The synchronous truth lives in `annotRef` (mode + current style/tool); React state only
      // mirrors it for rendering. Committed geometry is stored in canvas CSS px, so a C/scale change
      // moves the drawing with the content instead of re-basing it.
      const [annotOn, setAnnotOn] = React.useState(false);
      const [annotTool, setAnnotTool] = React.useState(ANNOT_DEFAULT.tool);
      const [annotColor, setAnnotColor] = React.useState(ANNOT_DEFAULT.color);
      const [annotWidth, setAnnotWidth] = React.useState(ANNOT_DEFAULT.width);
      const [annotStyleMode, setAnnotStyleMode] = React.useState('stroke');
      // Bumped on every commit/clear: committed shapes are only copied into React on commit, never
      // per pointer move (the live draft is an imperative SVG node updated by rAF).
      const [annotVersion, setAnnotVersion] = React.useState(0);
      const [annotText, setAnnotText] = React.useState(null);
      const annotRef = React.useRef({
        on: false,
        tool: ANNOT_DEFAULT.tool,
        color: ANNOT_DEFAULT.color,
        width: ANNOT_DEFAULT.width,
        mode: 'stroke',
        fill: ANNOT_DEFAULT.fill,
        stroke: ANNOT_DEFAULT.stroke,
      });
      const annotShapesRef = React.useRef([]);
      const annotNextIdRef = React.useRef(0);
      const annotGestureRef = React.useRef({
        active: false, pointerId: -1, map: null, tool: '', style: null,
        start: null, end: null, points: [], trace: [], pathLen: 0,
        lastScreen: null, lastSampleScreen: null, lastPoint: null, nodes: null,
      });
      const annotDraftRef = React.useRef(null);
      const annotSvgRef = React.useRef(null);
      const annotInputRef = React.useRef(null);
      const annotEditRef = React.useRef({ active: false, cancel: false, x: 0, y: 0, style: null });
      const annotEditSeqRef = React.useRef(0);
      const annotComposingRef = React.useRef(false);
      const annotRafRef = React.useRef(0);
      const annotEpochRef = React.useRef(null);
      const annotButtonRef = React.useRef(null);
      const annotPanelIdRef = React.useRef('');
      const annotMapSigRef = React.useRef('');
      // ---- P0-D v3 标注工作区文档（docs/viewport-control.md）--------------------------------
      // `annotSync` is only the render mirror; the synchronous truth (queue, in-flight snapshot,
      // identity, revisions) lives in module-level publishers keyed by scope/runtime/surface so an
      // unmount cannot lose unacknowledged content.
      const [annotSync, setAnnotSync] = React.useState({ state: 'idle', revision: 0 });
      const [annotStaleState, setAnnotStaleState] = React.useState({ stale: false, staleReason: null });
      // A live gesture/erase exists (drives the 清除画布 disabled state without per-move renders).
      const [annotBusy, setAnnotBusy] = React.useState(false);
      // 标注栏「截图」的状态：按钮进行态 + 就地提示（成功/失败原因都给具体文案）。
      // 光标形状传递：预览层跟随页面命中元素的 computed cursor（手型/文本/抓取…），
      // 而不是永远显示箭头。只接受 CSS 关键字白名单，`url(...)` 一律不落到样式上。
      const [frameCursor, setFrameCursor] = React.useState('auto');
      const [annotShotBusy, setAnnotShotBusy] = React.useState(false);
      const [annotShotNotice, setAnnotShotNotice] = React.useState('');
      const annotSyncRef = React.useRef({ state: 'idle', timer: 0 });
      // Identity gate: no old shape is rendered or published before the new scope's first trusted
      // state. `epoch` is the scope generation the gate belongs to; `key` is the D key.
      const annotGateRef = React.useRef({ epoch: -1, open: false, key: '', revision: -1, context: null, d: null, scope: null, view: null });
      const annotContentSeqRef = React.useRef(0);
      const annotDirtyRef = React.useRef(false);
      const annotCandidateRef = React.useRef(null);
      const annotStaleRef = React.useRef({ stale: false, staleReason: null });
      const annotShownRevisionRef = React.useRef(0);
      const annotPublisherRef = React.useRef(null);
      const annotUnsubRef = React.useRef(null);
      const annotMountGenerationRef = React.useRef(0);
      if (!annotMountGenerationRef.current) {
        annotMountSerial += 1;
        annotMountGenerationRef.current = annotMountSerial;
      }
      // Mirrors the capability fact for callbacks that must not read render closures.
      const annotChannelRef = React.useRef(false);
      const annotEraseRef = React.useRef({ active: false, pointerId: -1, map: null, last: null, changed: 0 });
      // 选择/框选（v3）：选中集合只用图形 id 表达；框选与拖动各有一条互斥手势。
      const annotSelectionRef = React.useRef(new Set());
      const annotSelectionRafRef = React.useRef(0);
      const annotMarqueeRef = React.useRef({ active: false, pointerId: -1, map: null, start: null, end: null, node: null });
      const annotMoveRef = React.useRef({ active: false, pointerId: -1, map: null, start: null, last: null, origin: null, changed: false });
      /** Hover cursor for the select tool: 'move' over a movable shape/selection box, else 'default'. */
      const annotHoverRef = React.useRef('default');
      const annotHitCtxRef = React.useRef(null);
      // ---- 选元素发送到聊天框 ----------------------------------------------------------------
      // 同步真值在 pickRef（模式闸），React 状态只镜像渲染；悬浮命中 80ms 节流 + 单飞，
      // 过期响应按序号 + scopeEpoch 丢弃。页面输入由 sendEvents / pointer 处理器统一闸掉。
      const [pickOn, setPickOn] = React.useState(false);
      const [pickOverlay, setPickOverlay] = React.useState(null);
      const [pickStatus, setPickStatus] = React.useState(null);
      const pickRef = React.useRef({
        on: false,
        hoverSeq: 0,
        hoverInflight: false,
        hoverQueued: false,
        timer: 0,
        wheelTimer: 0,
        lastClient: null,
        lastAt: 0,
        detailSeq: 0,
        detailInflight: false,
      });
      const pickStatusTimerRef = React.useRef(0);
      const pickButtonRef = React.useRef(null);

      // Immutable scope/binding for this generation. A `recent` identity is pinned to the Host
      // runtime id returned by the first /state (or /ensure); `binding` is empty until then.
      const seatSessionId = props && typeof props.seatSessionId === 'string' ? props.seatSessionId : '';
      const visible = !props || props.visible !== false;
      // Human-foreground claim (P0-D `browser_annotation`): recycled by this mount lifetime, added
      // while the seat is visible and withdrawn on unmount, so the Host's window can expire.
      const foregroundClaimRef = React.useRef('');
      if (!foregroundClaimRef.current) foregroundClaimRef.current = newGuiForegroundClaim();
      React.useEffect(() => {
        const claim = foregroundClaimRef.current;
        if (visible) guiForegroundClaims.add(claim);
        else guiForegroundClaims.delete(claim);
        return () => guiForegroundClaims.delete(claim);
      }, [visible]);
      const capture = props && props.capture ? props.capture : { sessionId: '', resolution: 'none' };
      // Internal browser tabs (one Runtime per tab): the Host group list is the only source.
      const panelViews = remote && remote.ui && remote.ui.version === 1 && Array.isArray(remote.ui.views)
        ? remote.ui : null;
      const [activeViewId, setActiveViewId] = React.useState('primary');
      const [tabsVisible, setTabsVisible] = React.useState(true);
      // A sibling tab switch is not a workspace retirement: do not poison retiredRuntimeRef.
      const viewSwitchRef = React.useRef(false);
      // The group list must survive the transient remote=null/idle snapshot while a child scope
      // is being opened. Deriving it from the current scope's remote alone unmounts the strip and
      // falls back to primary mid-switch (observed in the local smoke).
      const stableViewsRef = React.useRef(null);
      if (panelViews) {
        stableViewsRef.current = {
          views: panelViews.views, viewsRevision: panelViews.viewsRevision,
          primaryRuntimeId: panelViews.primaryRuntimeId,
          popupNotices: Array.isArray(panelViews.popupNotices) ? panelViews.popupNotices : [],
        };
      }
      const stableViews = stableViewsRef.current;
      const readyViewList = stableViews ? stableViews.views.filter((view) => view && view.status === 'ready') : [];
      const activeView = readyViewList.find((view) => view.id === activeViewId)
        || readyViewList.find((view) => view.kind === 'primary') || null;
      const childBinding = activeView && activeView.kind === 'popup' ? String(activeView.runtimeId || '') : '';
      const baseIdentity = resolvePanelIdentity(seatSessionId, capture, props && props.liveCapture);
      // A child tab explicitly binds to its Runtime; primary keeps the original session/recent
      // identity (never convert the session into the child, never re-resolve recent to it).
      const identity = childBinding
        ? { kind: 'recent', sessionId: '', key: 'view:' + childBinding, paused: false }
        : baseIdentity;
      const identityKey = identity.key;
      const [bindingState, setBindingState] = React.useState({ identityKey: '', value: '' });
      const [legacyState, setLegacyState] = React.useState({ identityKey: '', value: false });
      const binding = bindingState.identityKey === identityKey ? bindingState.value : '';
      const legacyHost = legacyState.identityKey === identityKey ? legacyState.value : false;
      const activeBinding = childBinding || binding;
      const ready = childBinding ? true : (identity.kind === 'session' || Boolean(binding) || legacyHost);
      const scope = React.useMemo(
        () => scopeSnapshot(childBinding ? 'recent' : identity.kind, childBinding ? '' : identity.sessionId, activeBinding, childBinding ? false : legacyHost),
        [identity.kind, identity.sessionId, activeBinding, legacyHost, childBinding],
      );
      const scopeKey = scope.kind + ':' + scope.sessionId + '|' + scope.binding + (scope.legacy ? '|legacy' : '');
      // Every scope/binding transition (including a discarded binding that re-resolves to the
      // same runtime id) must rebuild the transport/pollers even when the scope values repeat.
      const scopeEpochRef = React.useRef(0);
      const scopeTokenRef = React.useRef('');
      if (scopeTokenRef.current !== scopeKey) {
        scopeTokenRef.current = scopeKey;
        scopeEpochRef.current += 1;
      }
      const scopeEpoch = scopeEpochRef.current;
      const scopeRef = React.useRef(scope);
      scopeRef.current = scope;
      // Host config for this panel scope: the selector's allowed environments and current
      // resolution come from the Host, not from the static ENVIRONMENTS list.
      const hostConfig = useHostConfig(scope, 'session');
      // 设置页改完开关/选择后立刻同步过来：重读一次配置，组合框与视图跟着变，不用等刷新。
      useHostConfigChange(() => {
        if (hostConfig && typeof hostConfig.reload === 'function') hostConfig.reload();
      });
      const hostResolved = hostConfig.state.resolved || null;
      const resolvedEnvironment = hostResolved && hostResolved.environment ? String(hostResolved.environment) : '';
      const allowedEnvironments = hostResolved && Array.isArray(hostResolved.enabledEnvironments)
        ? hostResolved.enabledEnvironments.map(String) : null;
      /**
       * 组合框**只列开关已打开的目标环境**（`environments.<id>.enabled`）：
       * 开了 web + android，就只出现这两个选项。打开的但视图层没实现 → 选中后渲染空态
       * （执行环境不变）。宿主配置还没读到（`config` 为 null）时按可执行集合 + web 兜底，
       * 免得一上来列表是空的。
       */
      const envEnabledList = React.useMemo(() => ENVIRONMENTS
        .map((option) => {
          const fromConfig = enabledFromConfig(hostConfig.state.config, option.id);
          const enabled = fromConfig === null
            ? (option.id === 'web' || (allowedEnvironments ? allowedEnvironments.indexOf(option.id) !== -1 : false))
            : fromConfig;
          return Object.assign({}, option, { enabled });
        })
        .filter((option) => option.enabled), [hostConfig.state.config, allowedEnvironments]);
      const envOptions = React.useMemo(() => (envEnabledList.length
        ? envEnabledList
        : ENVIRONMENTS.filter((option) => option.id === 'web').map((option) => Object.assign({}, option, { enabled: true }))),
      [envEnabledList]);

      // 当前选中的环境被关掉时（用户在设置页关开关），退回宿主当前执行环境，避免组合框空值。
      React.useEffect(() => {
        if (envOptions.some((option) => option.id === env)) return;
        const fallback = envOptions.some((option) => option.id === resolvedEnvironment)
          ? resolvedEnvironment
          : ((envOptions[0] && envOptions[0].id) || 'web');
        setEnv(fallback);
      }, [envOptions, env, resolvedEnvironment]);
      React.useEffect(() => {
        if (!resolvedEnvironment) return;
        const option = ENVIRONMENTS.find((item) => item.id === resolvedEnvironment);
        if (!option || !option.ready) return; // an unimplemented environment never becomes current
        setEnv((current) => (current === resolvedEnvironment ? current : resolvedEnvironment));
      }, [resolvedEnvironment]);
      const visibleRef = React.useRef(true);
      visibleRef.current = visible;
      const readyRef = React.useRef(false);
      readyRef.current = ready;
      const writesPausedRef = React.useRef(false);
      writesPausedRef.current = identity.paused;
      const abortRef = React.useRef(null);
      const bindingAttemptsRef = React.useRef({ identityKey: '', count: 0 });
      if (bindingAttemptsRef.current.identityKey !== identityKey) bindingAttemptsRef.current = { identityKey, count: 0 };
      // The first unresolved→bound transition is this panel's own resolution of `recent`: it must
      // not abort the ensure/viewport/navigate chain that produced it. Any later binding change
      // (runtime replaced, binding lost) retires the old scope exactly like an identity change.
      // The reset epoch only advances on transitions, so repeated renders of the same scope never
      // schedule another reset (which would abort the resolver's own re-resolution request).
      const resetHistoryRef = React.useRef({ identityKey: '', value: '' });
      const resetEpochRef = React.useRef(0);
      if (resetHistoryRef.current.identityKey !== identityKey) {
        resetHistoryRef.current = { identityKey, value: binding };
        resetEpochRef.current += 1;
      } else if (resetHistoryRef.current.value !== binding) {
        const previousBinding = resetHistoryRef.current.value;
        resetHistoryRef.current = { identityKey, value: binding };
        if (previousBinding || !binding) resetEpochRef.current += 1;
      }
      const resetKey = resetEpochRef.current;

      function adoptBinding(value) {
        const next = value ? String(value) : '';
        if (!next) return;
        setBindingState((current) => (current.identityKey === identityKey && current.value === next ? current : { identityKey, value: next }));
      }

      function discardBinding(value) {
        const next = value ? String(value) : '';
        setBindingState((current) => (current.identityKey === identityKey && current.value === next ? { identityKey, value: '' } : current));
      }

      function markLegacyHost() {
        warnLegacyHost();
        setLegacyState((current) => (current.identityKey === identityKey && current.value ? current : { identityKey, value: true }));
      }

      /** Pin a recent scope to the runtime id the Host reported (cold entry or ensure). */
      const seenViewIdsRef = React.useRef(null);
      React.useEffect(() => {
        if (!stableViews) return;
        const ids = new Set(stableViews.views.map((view) => view.id));
        if (!seenViewIdsRef.current) { seenViewIdsRef.current = ids; return; }
        const fresh = stableViews.views.find((view) => view.kind === 'popup' && view.status === 'ready'
          && view.createdBy === 'gui' && !seenViewIdsRef.current.has(view.id));
        seenViewIdsRef.current = ids;
        // A new GUI popup becomes active once; existing tabs on a later mount do not replay.
        if (fresh) { viewSwitchRef.current = true; retiredRuntimeRef.current = ''; setActiveViewId(fresh.id); }
      }, [stableViews ? stableViews.viewsRevision : null]);
      React.useEffect(() => {
        if (!stableViews) return;
        if (stableViews.views.some((view) => view.id === activeViewId)) return;
        const primary = stableViews.views.find((view) => view.kind === 'primary');
        if (primary) { viewSwitchRef.current = true; retiredRuntimeRef.current = ''; setActiveViewId(primary.id); }
      }, [stableViews ? stableViews.viewsRevision : null, activeViewId]);

      // A workspace/session identity change must not keep the previous workspace's tab group.
      React.useEffect(() => {
        stableViewsRef.current = null;
        setActiveViewId('primary');
      }, [baseIdentity.key]);
      // A different primary binding in the same recent identity is a workspace change; a child
      // selection itself (childBinding) must never wipe the stable group.
      React.useEffect(() => {
        if (childBinding || !binding || !stableViews) return;
        if (stableViews.primaryRuntimeId && String(stableViews.primaryRuntimeId) !== String(binding)) {
          stableViewsRef.current = null;
          setActiveViewId('primary');
        }
      }, [binding, childBinding]);

      function switchView(viewId) {
        if (!viewId || viewId === activeViewId) return;
        if (annotRef.current.on) toggleAnnotMode();
        if (panModeRef.current) {
          panModeRef.current = false;
          setPanMode(false);
          cancelPanDrag();
          flushPanWrite();
        }
        viewSwitchRef.current = true;
        retiredRuntimeRef.current = '';
        setActiveViewId(viewId);
      }

      function newTab() {
        if (!tabsSupported || tabOpening) return;
        if (annotRef.current.on) toggleAnnotMode();
        if (panModeRef.current) {
          panModeRef.current = false;
          setPanMode(false);
          cancelPanDrag();
          flushPanWrite();
        }
        setTabOpening(true);
        setTabNotice('');
        callHost('tabs', { action: 'open' }, { scope: scopeRef.current }).then(() => {
          setTabOpening(false);
        }).catch((error) => {
          setTabOpening(false);
          const code = String((error && error.code) || '');
          const text = code === 'TAB_LIMIT'
            ? '最多 4 个标签；请先关闭一个标签'
            : '新建标签失败，请稍后重试';
          setTabNotice(text);
          window.clearTimeout(tabNoticeTimerRef.current);
          tabNoticeTimerRef.current = window.setTimeout(() => setTabNotice(''), 4000);
        });
      }

      function showTabNotice(text) {
        setTabNotice(text);
        window.clearTimeout(tabNoticeTimerRef.current);
        tabNoticeTimerRef.current = window.setTimeout(() => setTabNotice(''), 4000);
      }

      /** Drop one view from the cached group list the moment the Host confirms its close. */
      function dropClosedView(view) {
        const current = stableViewsRef.current;
        if (!current || !view) return;
        const views = current.views.filter((item) => item && item.id !== view.id);
        if (views.length === current.views.length) return;
        stableViewsRef.current = { ...current, views, viewsRevision: (current.viewsRevision || 0) + 1 };
        setTabsTick((value) => value + 1);
      }

      function closeView(view) {
        if (!view) return;
        if (view.kind === 'primary') {
          // Close the last (primary) tab into the EMPTY state: the fixed primary slot goes cold,
          // so the strip renders no tabs at all and keeps only the `+` entry. Target it by runtime
          // id so closing still addresses primary while a child tab is active.
          const primaryRuntimeId = stableViews && stableViews.primaryRuntimeId ? String(stableViews.primaryRuntimeId) : '';
          if (!primaryRuntimeId) return;
          setTabNotice('');
          callHost('close', {}, { scope: scopeSnapshot('recent', '', primaryRuntimeId, false) }).then(() => {
            viewSwitchRef.current = true;
            retiredRuntimeRef.current = '';
            setActiveViewId('primary');
          }).catch((error) => {
            const code = String((error && error.code) || '');
            showTabNotice(code === 'BUSY'
              ? '标签正在执行操作，稍后再关闭'
              : '关闭标签失败，请稍后重试');
          });
          return;
        }
        // Close with the child's own binding. The Host answer is the only success signal; on
        // success an active child falls back locally (its own /state may already be gone).
        callHost('close', {}, { scope: scopeSnapshot('recent', '', view.runtimeId, false) }).then(() => {
          // The Host answer is the success signal: retire the view locally so the strip, the
          // active tab and the empty state do not wait one more /state poll to agree.
          dropClosedView(view);
          if (activeViewId === view.id) {
            viewSwitchRef.current = true;
            retiredRuntimeRef.current = '';
            setActiveViewId('primary');
          }
        }).catch((error) => {
          const code = String((error && error.code) || '');
          // A refused close is never silent: the tab stays in the strip, so the user has to learn
          // why (a stale/unknown binding now answers SCOPE_NOT_FOUND instead of a fake ok).
          if (code === 'BUSY') showTabNotice('标签正被 Agent 操作；稍后再关闭');
          else showTabNotice('关闭标签失败，请稍后重试');
        });
      }

      function noteHostScope(payload) {
        const current = scopeRef.current;
        if (!current || current.kind !== 'recent' || childBinding) return;
        if (!hasScopeEvidence(payload)) return;
        const runtimeId = runtimeIdOf(payload);
        if (!runtimeId) return;
        if (runtimeId !== current.binding) adoptBinding(runtimeId);
      }

      function noteLegacyHost(payload) {
        if (!payload || hasScopeEvidence(payload)) return;
        markLegacyHost();
      }

      function ingestHostState(state) {
        noteHostScope(state);
        noteLegacyHost(state);
        acceptRemote(state);
      }

      const ui = remote && remote.ui && remote.ui.version === 1 ? remote.ui : null;
      const displayMode = ui && ui.display && ui.display.mode === 'headed' ? 'headed' : 'headless';
      const uiHistory = ui && ui.history && typeof ui.history === 'object' ? ui.history : null;
      const running = remote.running === true;
      /** Latest accepted address: raw v1 address, or the redacted url on an old host. */
      function acceptedAddress() {
        const accepted = remoteRef.current;
        const acceptedUi = accepted && accepted.ui && accepted.ui.version === 1 ? accepted.ui : null;
        return String((acceptedUi ? acceptedUi.address : accepted && accepted.url) || '');
      }
      const trueAddress = ui ? String(ui.address || '') : '';
      // The stage shows the runtime's real address; legacy hosts only have the redacted url.
      const activeUrl = ui ? trueAddress : String(remote.url || '');
      let host = '';
      try { host = activeUrl ? new URL(activeUrl).host : ''; } catch (e) { host = ''; }
      const busy = pending || navBusy;
      const backDisabled = annotOn || busy || !running || !ui || !uiHistory?.available || !uiHistory?.canGoBack;
      const forwardDisabled = annotOn || busy || !running || !ui || !uiHistory?.available || !uiHistory?.canGoForward;
      const reloadDisabled = annotOn || busy || !running || !trueAddress;
      const openUrl = (() => {
        if (!trueAddress) return '';
        try {
          const parsed = new URL(trueAddress);
          return parsed.protocol === 'http:' || parsed.protocol === 'https:' ? parsed.href : '';
        } catch { return ''; }
      })();

      /**
       * DevTools menu state (docs/internal/devtools-popup.md §5). Enabled only when this accepted
       * snapshot carries a strict loopback inspector URL for the live page, the GUI itself is on
       * loopback, the Web view is active and annotation mode is off. A Host without the field is
       * "unsupported" — the URL is never guessed from the page address.
       */
      const devtoolsInfo = (() => {
        const devtools = ui && ui.devtools && typeof ui.devtools === 'object' ? ui.devtools : null;
        if (!devtools) return { enabled: false, url: '', title: '当前运行时不支持调试工具' };
        if (!guiHostIsLoopback()) {
          return { enabled: false, url: '', title: '调试工具仅支持浏览器与 DSH 同机访问；远程 GUI 暂不支持' };
        }
        if (env !== 'web' || !running || devtools.available !== true) {
          return { enabled: false, url: '', title: '请先在调试视图中打开页面' };
        }
        const validated = validateDevtoolsUrl(devtools.url);
        if (!validated) return { enabled: false, url: '', title: '当前运行时不支持调试工具' };
        return { enabled: true, url: validated, title: '在独立窗口中调试当前页面；修改页面或模拟设置会影响自动化' };
      })();
      const devtoolsRuntimeId = ui ? String(ui.runtimeId || '') : '';
      // A scope/runtime switch drops the previous runtime's fallback link (its port may be gone).
      React.useEffect(() => { setDevtoolsNotice(null); }, [devtoolsRuntimeId]);

      /**
       * Open one fresh external DevTools window inside the user-activation stack.
       *
       * `window.open` must run before any await/fetch, so the accepted URL is used directly. The
       * features deliberately omit `noopener`: a blocked open and a successful `noopener` open both
       * return null, which would misreport the result. Instead the blank child is severed from the
       * opener synchronously. The navigation is performed by the child's own script with a
       * no-referrer policy — an opener-initiated `location.replace` would still send the GUI URL as
       * Referer. Only a null handle/exception falls back to a local aria-live hint + real link.
       */
      function openDevtools() {
        setMenu(false);
        // Same-tick guard: the menu is disabled in annotation mode; a stale render must not bypass it.
        if (annotOn || !devtoolsInfo.enabled) return;
        const validatedUrl = devtoolsInfo.url;
        const unique = globalThis.crypto && typeof globalThis.crypto.randomUUID === 'function'
          ? globalThis.crypto.randomUUID()
          : (Date.now().toString(36) + '-' + Math.random().toString(36).slice(2));
        // Runtime-scoped and unique per click; never contains the page URL or a filesystem path.
        const name = 'dsh-ui-testing-devtools-' + (devtoolsRuntimeId || 'runtime') + '-' + unique;
        let child = null;
        try {
          child = window.open('about:blank', name, 'popup=yes,width=1200,height=800,resizable=yes,scrollbars=yes');
        } catch (error) {
          child = null;
        }
        if (!child) {
          setDevtoolsNotice({
            message: '浏览器未返回调试窗口，可允许弹出窗口后重试，或点击链接打开。',
            url: validatedUrl,
          });
          return;
        }
        try {
          child.opener = null;
          const doc = child.document;
          if (!doc) throw new Error('no blank document');
          // `<` is escaped so the URL can never close the script element early.
          const literal = JSON.stringify(validatedUrl).replace(/</g, '\\u003c');
          doc.open();
          doc.write('<!doctype html><meta charset="utf-8"><meta name="referrer" content="no-referrer">'
            + '<title>DevTools</title><scr' + 'ipt>location.replace(' + literal + ')</scr' + 'ipt>');
          doc.close();
          setDevtoolsNotice(null);
        } catch (error) {
          // Close only the blank window this click created; never touch an existing DevTools window.
          try { child.close(); } catch (closeError) { /* ignore */ }
          setDevtoolsNotice({
            message: '无法打开调试窗口，可点击链接在新标签页打开调试工具。',
            url: validatedUrl,
          });
        }
      }

      /**
       * Single entry point for every runtime snapshot (/state, /frame, navigation responses).
       * v1 snapshots are ordered by runtimeId + revision so a late response cannot move the
       * address bar backwards; a retired runtime is dropped. The visible draft is only replaced
       * when the user is not editing (and no submit is in flight).
       */
      function acceptRemote(next) {
        if (!next || typeof next !== 'object') return false;
        const nextUi = next.ui && next.ui.version === 1 ? next.ui : null;
        const previous = remoteRef.current;
        const previousUi = previous && previous.ui && previous.ui.version === 1 ? previous.ui : null;
        if (nextUi) {
          const runtimeId = String(nextUi.runtimeId || '');
          if (retiredRuntimeRef.current && runtimeId === retiredRuntimeRef.current) return false;
          if (previousUi && String(previousUi.runtimeId) === runtimeId) {
            const nextRevision = Number(nextUi.revision);
            const previousRevision = Number(previousUi.revision);
            if (nextRevision < previousRevision) return false;
            if (nextRevision === previousRevision) {
              // The address/snapshot is unchanged, but `annotations.stale`/`staleReason` are
              // computed at read time: refresh that metadata without moving the version gate.
              annotHydrate(nextUi);
              return false;
            }
          }
          if (previousUi && String(previousUi.runtimeId) !== runtimeId) {
            // A new runtime/workspace: flush the old workspace's unconfirmed content under its own
            // frozen identity, then retract this panel's view. Never send an empty release (§12.1).
            annotRetainDirty(true);
            annotDropLocalView({ exit: false, discard: true });
            // A sibling tab switch is a local selection, not a retirement. Retiring the old
            // runtime would reject its later state when the user switches back.
            if (!viewSwitchRef.current) retiredRuntimeRef.current = String(previousUi.runtimeId || '');
            viewSwitchRef.current = false;
            dirtyRef.current = false;
            editVersionRef.current += 1;
            setError('');
          }
          // A document/address change invalidates the drawing (docs/viewport-control.md). The mode
          // itself is not exited here: an external navigation keeps the annotation mode on. A rotated
          // Host documentKey is the same fact without an address change (v2 §11.2).
          const previousToken = previousUi && previousUi.annotationContext
            ? String(previousUi.annotationContext.documentKey || '') : '';
          const nextToken = nextUi.annotationContext ? String(nextUi.annotationContext.documentKey || '') : '';
          const addressChanged = Boolean(previousUi && previousUi.address && nextUi.address
            && String(previousUi.address) !== String(nextUi.address));
          const tokenChanged = Boolean(previousToken && nextToken && previousToken !== nextToken);
          if (addressChanged || tokenChanged) {
            // Navigation = a new document. Retract locally only; the Host rotation clears the
            // document and a fresh empty document is NOT replayed into the new key (§12.1).
            annotDropLocalView({ exit: false, discard: true });
          }
        }
        remoteRef.current = next;
        setRemote(next);
        if (!pendingRef.current.active && !dirtyRef.current) {
          setDraft(nextUi ? String(nextUi.address || '') : String(next.url || ''));
        }
        // The shared view (when the Host has one) is adopted through the same accepted snapshot.
        acceptView(next);
        // Hydration runs *after* runtime/revision acceptance and view adoption (§12.2).
        if (nextUi) annotHydrate(nextUi);
        // Publish the post-adoption canvas signature: the frame transport re-seeds a static page
        // whenever C/S/scale/revision moved (docs/viewport-control.md).
        const transport = transportRef.current;
        if (transport && typeof transport.updateSeedContext === 'function') {
          try { transport.updateSeedContext(seedContext()); } catch { /* transport must not break UI */ }
        }
        return true;
      }

      /** Keep the accepted address in the input unless the user is editing it. */
      function syncDraft() {
        if (dirtyRef.current) return;
        setDraft(acceptedAddress());
      }
      /** Discard an unsubmitted edit and return to the last accepted address. */
      function cancelDraft() {
        if (!dirtyRef.current) return;
        dirtyRef.current = false;
        editVersionRef.current += 1;
        setDraft(acceptedAddress());
      }
      function changeAddress(event) {
        editVersionRef.current += 1;
        dirtyRef.current = true;
        setDraft(event.target.value);
        setError('');
      }
      function blurAddress() {
        if (!focusedRef.current) return;
        focusedRef.current = false;
        // A submit in flight keeps its submitted draft (and a newer edit made during it).
        if (pendingRef.current.active) return;
        cancelDraft();
      }
      function keyAddress(event) {
        if (event.key !== 'Escape') return;
        event.preventDefault();
        dirtyRef.current = false;
        editVersionRef.current += 1;
        setDraft(acceptedAddress());
        setError('');
      }

      /* ----------------------------------------------------------------------------------------
       * Address history (panel-local, docs/getting-started.md): the newest 7 visited HTTP(S)
       * addresses, newest first. Recorded from the *accepted* address, so a redirect or an Agent
       * navigation is stored as the page that actually loaded, and a failed navigation is not.
       * -------------------------------------------------------------------------------------- */
      // History is per workspace: the key carries the runtime's opaque workspace scope id, so a
      // second workspace never sees (or inherits) another workspace's addresses. An unresolved
      // scope reads nothing and never writes, instead of falling back to a shared bucket.
      const historyScopeId = ui && ui.scope && ui.scope.id ? String(ui.scope.id) : '';
      const [addressHistory, setAddressHistory] = React.useState(() => addressHistoryRead(addressHistoryStorage(), historyScopeId));
      const [historyOpen, setHistoryOpen] = React.useState(false);
      const historyAddress = acceptedAddress();
      React.useEffect(() => {
        setAddressHistory(addressHistoryRead(addressHistoryStorage(), historyScopeId));
      }, [historyScopeId]);
      React.useEffect(() => {
        if (!historyScopeId) return;
        if (!/^https?:\/\//i.test(historyAddress)) return;
        const storage = addressHistoryStorage();
        const current = addressHistoryRead(storage, historyScopeId);
        const next = addressHistoryPush(current, historyAddress);
        if (next.length === current.length && next[0] === current[0]) return;
        addressHistoryWrite(storage, historyScopeId, next);
        setAddressHistory(next);
      }, [historyAddress, historyScopeId]);
      // The dropdown is a local popover: it never survives a mode switch or a scope change.
      React.useEffect(() => {
        if (!historyOpen) return undefined;
        const close = (event) => { if (!event.target.closest || !event.target.closest('.utb-addr-wrap')) setHistoryOpen(false); };
        const escape = (event) => { if (event.key === 'Escape') setHistoryOpen(false); };
        document.addEventListener('mousedown', close);
        document.addEventListener('keydown', escape);
        return () => { document.removeEventListener('mousedown', close); document.removeEventListener('keydown', escape); };
      }, [historyOpen]);
      React.useEffect(() => { setHistoryOpen(false); }, [scopeEpoch, annotOn]);
      function chooseHistory(url) {
        setHistoryOpen(false);
        if (annotRef.current.on) return; // local navigation is disabled in annotation mode
        submit(undefined, url);
      }

      /* ----------------------------------------------------------------------------------------
       * Shared viewport state (Host `ui.view`).
       *
       * The Host view is authoritative for width/height/x/y/scale; every size-bar input is only
       * an edit draft. `fit` is a *local display preference*: it is never published, so opening a
       * panel can never change the Agent's default screenshot density. Agent (or another panel's)
       * changes cancel the local fit and are adopted as-is.
       * -------------------------------------------------------------------------------------- */

      /** CSS viewport of the accepted shared view; local drafts are the old-Host fallback. */
      function acceptedViewSize() {
        const view = viewRef.current;
        if (view && Number.isFinite(Number(view.width)) && Number.isFinite(Number(view.height))) {
          return { w: Number(view.width), h: Number(view.height) };
        }
        return { w: pageSize.w, h: pageSize.h };
      }

      /** Real scroll position: Host observed metrics first, then the last accepted view. */
      function observedScroll() {
        const observed = observedRef.current;
        const view = viewRef.current;
        const pick = (axis) => {
          const fact = observed ? Number(observed[axis]) : NaN;
          if (Number.isFinite(fact)) return fact;
          const accepted = view ? Number(view[axis]) : NaN;
          return Number.isFinite(accepted) ? accepted : 0;
        };
        return { x: pick('x'), y: pick('y') };
      }

      function formatScroll(value) {
        const number = Number(value);
        if (!Number.isFinite(number)) return '0';
        return String(Math.round(number * 100) / 100);
      }

      /* ---- P0-C v2 canvas state (docs/viewport-control.md) --------------------------- */

      /** True when the Host exposes the canvas projection AND a shared view to hold it. */
      function canvasActive() {
        return Boolean(viewRef.current && canvasRef.current);
      }

      /** Accepted canvas origin C plus its content box; null when the Host has no canvas support. */
      function canvasPosition() {
        const canvas = canvasRef.current;
        if (!canvas || !viewRef.current) return null;
        const x = Number(canvas.x);
        const y = Number(canvas.y);
        if (!Number.isFinite(x) || !Number.isFinite(y)) return null;
        return {
          x,
          y,
          contentWidth: Number(canvas.contentWidth),
          contentHeight: Number(canvas.contentHeight),
        };
      }

      /** O = C - S (derived, never persisted); S prefers the latest real observation. */
      function canvasOffset() {
        const canvas = canvasPosition();
        if (!canvas) return null;
        const scroll = observedScroll();
        return {
          canvas,
          scroll,
          offsetX: canvas.x - scroll.x,
          offsetY: canvas.y - scroll.y,
        };
      }

      /**
       * Seed signature published to the frame transport: the shell canvas/scroll/scale state a PNG
       * seed must be composed at. A Host without a canvas keeps the historical plain-page seed.
       */
      function seedContext() {
        const view = viewRef.current;
        if (!view || !canvasActive()) return { legacy: true };
        const canvas = canvasPosition();
        if (!canvas) return { legacy: true };
        const scroll = observedScroll();
        return {
          canvasX: canvas.x,
          canvasY: canvas.y,
          scrollX: scroll.x,
          scrollY: scroll.y,
          viewRevision: Number(view.revision),
          scale: Number(view.scale),
          width: Number(view.width),
          height: Number(view.height),
        };
      }

      /** Stable signature of one seed context (same rounding as the transport key). */
      function seedContextSignature(context) {
        if (!context) return '';
        if (context.legacy) return 'legacy';
        const round = (value) => (Number.isFinite(Number(value)) ? Math.round(Number(value) * 100) / 100 : null);
        return [
          round(context.canvasX), round(context.canvasY),
          round(context.scrollX), round(context.scrollY),
          Number.isFinite(Number(context.viewRevision)) ? Number(context.viewRevision) : null,
          round(context.scale), round(context.width), round(context.height),
        ].join('|');
      }

      /**
       * Schedule one seed refresh check after a sustained barrier mismatch. A real seed refresh is
       * requested at most once per shell signature; the transport also dedups/fails closed.
       */
      function scheduleSeedRefreshCheck() {
        // A cold page must never be started just to satisfy a panel hint: only an already running
        // target with a live transport may request a composed seed.
        if (!canvasActive() || remoteRef.current?.running !== true) return;
        if (typeof transportRef.current?.requestSeedRefresh !== 'function') return;
        const context = seedContext();
        const key = seedContextSignature(context);
        if (!key || key === seedAttemptKeyRef.current) return;
        const barrier = canvasBarrier();
        if (barrier.ready || !SEED_REFRESH_REASONS.has(barrier.reason)) return;
        if (seedRefreshTimerRef.current) {
          if (seedCheckKeyRef.current === key) return;
          window.clearTimeout(seedRefreshTimerRef.current);
          seedRefreshTimerRef.current = 0;
        }
        seedCheckKeyRef.current = key;
        seedRefreshTimerRef.current = window.setTimeout(() => {
          seedRefreshTimerRef.current = 0;
          if (!canvasActive() || remoteRef.current?.running !== true) return;
          const currentContext = seedContext();
          const currentKey = seedContextSignature(currentContext);
          if (!currentContext || currentKey !== key || currentKey === seedAttemptKeyRef.current) return;
          const currentBarrier = canvasBarrier();
          if (currentBarrier.ready || !SEED_REFRESH_REASONS.has(currentBarrier.reason)) return;
          seedAttemptKeyRef.current = currentKey;
          const transport = transportRef.current;
          if (transport && typeof transport.requestSeedRefresh === 'function') {
            try { transport.requestSeedRefresh(currentContext); } catch { /* transport must not break UI */ }
          }
        }, SEED_STALE_MS);
      }

      /** Adopt `ui.canvas` (or its absence) without re-rendering on every identical poll. */
      function adoptCanvas(canvas) {
        const next = canvas && typeof canvas === 'object' ? canvas : null;
        const previous = canvasRef.current;
        const changed = Boolean(previous) !== Boolean(next) || (previous && next
          && ['x', 'y', 'offsetX', 'offsetY', 'contentWidth', 'contentHeight']
            .some((key) => Number(previous[key]) !== Number(next[key])));
        canvasRef.current = next;
        if (changed) setCanvasInfo(next);
        // An old Host (or a shared view that lost its canvas) must not leave a grab hand behind.
        if (!next && panModeRef.current) {
          panModeRef.current = false;
          setPanMode(false);
          cancelPanDrag();
          flushPanWrite();
        }
      }

      /**
       * Fail-closed geometry/scroll barrier for canvas input (docs/viewport-control.md).
       *
       * O=0 keeps the old (best-effort, ≤250ms) barrier only. When O≠0 the displayed frame must
       * prove the current page scroll: `frame.scroll` within ±1 CSS px of S and the capture page
       * size matching the accepted viewport. Missing metadata is *not* satisfied — and there is
       * deliberately no timeout that would let a stale frame through.
       */
      function canvasBarrier() {
        const info = canvasOffset();
        if (!info) return { ready: true, reason: 'no-canvas' };
        const geom = frameGeomRef.current;
        const view = viewRef.current;
        // A PNG seed is already composited at its capture C; it is only usable while the live
        // C/S/revision/scale still agree (docs/viewport-control.md). A stale or
        // provenance-less seed is fail-closed until the transport refreshes it.
        if (geom && geom.seed) {
          const near = (a, b, tolerance) => Number.isFinite(Number(a)) && Number.isFinite(Number(b)) && Math.abs(Number(a) - Number(b)) <= tolerance;
          const facts = [geom.seedCanvasX, geom.seedCanvasY, geom.seedScrollX, geom.seedScrollY,
            geom.seedViewRevision, geom.seedScale, geom.seedWidth, geom.seedHeight];
          if (!view || geom.seedComposite !== true || facts.some((value) => value === null)) {
            return { ready: false, reason: 'seed-provenance-missing', info };
          }
          const aligned = near(geom.seedCanvasX, info.canvas.x, 1)
            && near(geom.seedCanvasY, info.canvas.y, 1)
            && near(geom.seedScrollX, info.scroll.x, 1)
            && near(geom.seedScrollY, info.scroll.y, 1)
            && Number(geom.seedViewRevision) === Number(view.revision)
            && near(geom.seedScale, view.scale, 0.001)
            && near(geom.seedWidth, view.width, 1)
            && near(geom.seedHeight, view.height, 1);
          return aligned
            ? { ready: true, reason: 'seed-aligned', info }
            : { ready: false, reason: 'seed-stale', info };
        }
        const isZero = Math.abs(info.offsetX) < 0.5 && Math.abs(info.offsetY) < 0.5;
        if (isZero) return { ready: true, reason: 'o-zero', info };
        if (!geom) return { ready: false, reason: 'no-frame', info };
        const scrollX = finiteOrNull(geom.scrollX);
        const scrollY = finiteOrNull(geom.scrollY);
        if (scrollX === null || scrollY === null) {
          return { ready: false, reason: 'frame-scroll-missing', info };
        }
        const size = acceptedViewSize();
        const pageWidth = Number(geom.pageWidth);
        const pageHeight = Number(geom.pageHeight);
        if (!(pageWidth > 0) || !(pageHeight > 0)
          || Math.abs(pageWidth - size.w) > 1 || Math.abs(pageHeight - size.h) > 1) {
          return { ready: false, reason: 'page-size-mismatch', info, pageWidth, pageHeight, size };
        }
        if (Math.abs(scrollX - info.scroll.x) > 1 || Math.abs(scrollY - info.scroll.y) > 1) {
          return { ready: false, reason: 'scroll-mismatch', info, frameScroll: { x: scrollX, y: scrollY } };
        }
        return { ready: true, reason: 'aligned', info, frameScroll: { x: scrollX, y: scrollY } };
      }

      /** Dispatchable page point p = q + O, or `blank` when the canvas point is outside content. */
      function mapEventPoint(event, geom) {
        const size = acceptedViewSize();
        const u = (event.clientX - geom.left) / geom.width;
        const v = (event.clientY - geom.top) / geom.height;
        const q = {
          x: clampNumber(u * size.w, 0, Math.max(0, size.w - POINTER_EPSILON)),
          y: clampNumber(v * size.h, 0, Math.max(0, size.h - POINTER_EPSILON)),
        };
        const inside = u >= 0 && u < 1 && v >= 0 && v < 1;
        const info = canvasOffset();
        if (!info) return { inside, blank: false, q, x: q.x, y: q.y };
        const offsetX = info.offsetX;
        const offsetY = info.offsetY;
        // O=0 is the documented old-behaviour regression point (docs/viewport-control.md): the
        // frame covers the whole box (there is no composited white to protect) and input keeps the
        // legacy mapping. Only a real residual O creates a blank band that must be zero-dispatched.
        if (Math.abs(offsetX) < 0.5 && Math.abs(offsetY) < 0.5) {
          return { inside, blank: false, q, x: q.x, y: q.y };
        }
        const d = { x: q.x + info.canvas.x, y: q.y + info.canvas.y };
        const p = { x: q.x + offsetX, y: q.y + offsetY };
        const contentWidth = info.canvas.contentWidth;
        const contentHeight = info.canvas.contentHeight;
        // No provable content box ⇒ fail closed (never assume "everything is content").
        const inContent = Number.isFinite(contentWidth) && Number.isFinite(contentHeight)
          && contentWidth > 0 && contentHeight > 0
          && d.x >= 0 && d.x < contentWidth && d.y >= 0 && d.y < contentHeight;
        const inViewport = p.x >= 0 && p.x < size.w && p.y >= 0 && p.y < size.h;
        return { inside, blank: !(inContent && inViewport), q, d, x: p.x, y: p.y };
      }

      /** Local fit ratio (contract §4.3): fit is display-only and clamped to the manual range. */
      function fitScaleValue() {
        const size = acceptedViewSize();
        if (!(room.w > 24) || !(room.h > 24)) return 1;
        const ratio = Math.min(1, (room.w - 48) / size.w, (room.h - 24) / size.h);
        return clampNumber(ratio, VIEW_LIMITS.scalePercent[0] / 100, 1);
      }

      /**
       * Show the accepted view in every input the user is not editing right now.
       *
       * Only an *edited* draft (dirty) is protected — the same rule the address bar uses. Merely
       * placing the caret in a field must not freeze it: a field that was focused but never
       * edited would otherwise keep showing a value the shared view has already moved away from.
       */
      function syncViewDrafts() {
        const view = viewRef.current;
        if (!view) return;
        const dirty = viewDirtyRef.current;
        const scroll = observedScroll();
        const canvas = canvasPosition();
        if (dirty.width === null) setWidth(String(Number(view.width) || 200));
        if (dirty.height === null) setHeight(String(Number(view.height) || 200));
        if (dirty.x === null) setPosX(formatScroll(canvas ? canvas.x : scroll.x));
        if (dirty.y === null) setPosY(formatScroll(canvas ? canvas.y : scroll.y));
        if (dirty.scale === null && !fitRef.current) {
          setZoom(String(Math.round(clampNumber(Number(view.scale) * 100, VIEW_LIMITS.scalePercent[0], VIEW_LIMITS.scalePercent[1]))));
        }
      }

      /**
       * Clear the edit flag of a field whose draft already equals the accepted truth (e.g. a wheel
       * step the Host has now applied). A field the user is still changing keeps its flag.
       */
      function clearCaughtUpDrafts(view) {
        const dirty = viewDirtyRef.current;
        const accepted = {
          width: Number(view.width),
          height: Number(view.height),
          scale: Number(view.scale) * 100,
        };
        for (const field of ['width', 'height', 'scale']) {
          const draftValue = dirty[field];
          if (draftValue === null) continue;
          if (Number.isFinite(draftValue) && Math.abs(draftValue - accepted[field]) <= 0.001) dirty[field] = null;
        }
      }

      /**
       * Adopt one Host view. An Agent change (or another panel's `gui` write) wins over the local
       * fit preference; a page-driven scroll only moves x/y and keeps fit.
       */
      function adoptView(view, viewMeta, observed) {
        if (!view || typeof view !== 'object') return;
        const previous = viewRef.current;
        const previousObserved = observedRef.current;
        viewRef.current = view;
        if (viewMeta !== undefined) viewMetaRef.current = viewMeta || null;
        if (observed !== undefined) observedRef.current = observed || null;
        // The barrier is computed from refs (S + view geometry); re-render when either moved so the
        // painted surface state cannot disagree with what the pointer/wheel handlers would enforce.
        const zoomIntent = zoomIntentRef.current;
        if (zoomIntent.scale !== null) {
          const intentSettled = Math.abs(Number(view.scale) - Number(zoomIntent.scale)) <= 0.0011
            && (zoomIntent.x === null || Math.abs(Number(view.canvasX) - Number(zoomIntent.x)) <= 1)
            && (zoomIntent.y === null || Math.abs(Number(view.canvasY) - Number(zoomIntent.y)) <= 1)
            && (zoomIntent.w === null || Math.abs(Number(view.width) - Number(zoomIntent.w)) <= 0.5)
            && (zoomIntent.h === null || Math.abs(Number(view.height) - Number(zoomIntent.h)) <= 0.5);
          if (intentSettled) clearZoomIntent();
        }
        const zoomPending = canvasZoomRef.current;
        if (zoomPending.scale !== null) {
          const zoomMatches = Math.abs(Number(view.scale) - Number(zoomPending.scale)) <= 0.0011
            && (zoomPending.x === null || Math.abs(Number(view.canvasX) - Number(zoomPending.x)) <= 1)
            && (zoomPending.y === null || Math.abs(Number(view.canvasY) - Number(zoomPending.y)) <= 1)
            && (zoomPending.w === null || Math.abs(Number(view.width) - Number(zoomPending.w)) <= 0.5)
            && (zoomPending.h === null || Math.abs(Number(view.height) - Number(zoomPending.h)) <= 0.5);
          // Keep the accumulator only for our own zoom ACK/echo; any other view change re-anchors.
          if (!zoomMatches) canvasZoomRef.current = { scale: null, x: null, y: null, at: 0 };
        }
        const refMoved = (a, b, keys) => !a || !b || keys.some((key) => Number(a[key]) !== Number(b[key]));
        const viewMoved = refMoved(previous, view, ['x', 'y', 'width', 'height']);
        const observedMoved = observed !== undefined && refMoved(previousObserved, observedRef.current, ['x', 'y', 'width', 'height', 'contentWidth', 'contentHeight']);
        const revisionMoved = !previous || Number(previous.revision) !== Number(view.revision);
        if (viewMoved || observedMoved || revisionMoved) setBarrierVersion((value) => value + 1);
        const source = String(view.source || '');
        // Only a *content change* by someone else cancels the local fit; an unchanged poll must not
        // (otherwise a user could never keep 适应窗口 checked while state is polled every 500ms).
        const revisionChanged = !previous || Number(previous.revision) !== Number(view.revision);
        const external = source === 'agent'
          || (source === 'gui' && Number(view.revision) !== Number(selfViewRevisionRef.current));
        // 用户 2026-11-03 第 3 条：回访（accepted 非 default view）时 fit 保持 mount 默认 true；
        // 只有本次 mount 已经采纳过一份 view 之后的外部 revision 变化才取消本地 fit。
        if (previous && external && revisionChanged) {
          fitRef.current = false;
          setFit(false);
        }
        if (source === 'agent' && revisionChanged) {
          clearZoomIntent();
          resetZoomAnchor();
        }
        // A view that moved away from the active screen anchor without an in-flight zoom intent
        // supersedes that notch (script/size/scroll change): never apply its stale correction.
        const anchorNow = zoomAnchorRef.current;
        if (anchorNow.active && !activeZoomIntent() && Number.isFinite(Number(anchorNow.scale))
          && Math.abs(Number(view.scale) - Number(anchorNow.scale)) > 0.0011) {
          anchorNow.active = false;
          setZoomAnchorState('idle');
        }
        if (previous && (Number(previous.width) !== Number(view.width) || Number(previous.height) !== Number(view.height))) {
          pendingGeomRef.current = { since: Date.now() };
        }
        clearCaughtUpDrafts(view);
        syncViewDrafts();
        scheduleSeedRefreshCheck();
        scheduleZoomAnchorCheck();
      }

      /** Ingest the view part of one accepted Host snapshot (first binding included). */
      function acceptView(payload) {
        const state = payload && payload.state && typeof payload.state === 'object' ? payload.state : payload;
        const ui = state && state.ui && typeof state.ui === 'object' ? state.ui : null;
        // A snapshot without the GUI projection says nothing about the shared view: leave the
        // last accepted view (and the legacy fallback) untouched.
        if (!ui) return;
        const view = viewOf(state);
        const hadView = Boolean(viewRef.current);
        if (!view) {
          // Old Host (no shared view): keep the legacy local width/height path untouched, and
          // disable the canvas/drag surfaces (they need a shared view to write back to).
          viewRef.current = null;
          observedRef.current = null;
          adoptCanvas(null);
          if (hadView) setViewVersion((value) => value + 1);
          return;
        }
        adoptCanvas(canvasOf(state));
        maybeInitialViewPush(view);
        const companions = viewCompanionsOf(state);
        adoptView(view, companions.viewMeta, companions.observed);
        if (!hadView) setViewVersion((value) => value + 1);
      }

      /**
       * First binding of one scope generation: a cold/default Host view is replaced ONCE by this
       * panel's historical local default (393×852 @100%), which keeps the product behaviour of a
       * newly opened panel. Any other source is authoritative and is adopted without a write.
       */
      function maybeInitialViewPush(view) {
        const first = viewFirstBindRef.current;
        if (first.epoch !== scopeEpoch || first.done) return;
        first.done = true;
        if (String(view.source || '') !== 'default') return;
        const target = envDefaultSize(env);
        const dirty = viewDirtyRef.current;
        dirty.width = target.width;
        dirty.height = target.height;
        dirty.scale = 100;
        setWidth(String(target.width));
        setHeight(String(target.height));
        // 与 Host 现值完全相等时不发（不碰 revision）；否则照旧只发布一次。
        if (Number(view.width) === target.width && Number(view.height) === target.height
          && Number(view.scale) === 1) return;
        queueViewPatch({ width: target.width, height: target.height, scale: 1 });
      }

      /** Merge one field patch into the trailing debounce (at most one request in flight). */
      function queueViewPatch(patch, delayMs) {
        if (!patch || typeof patch !== 'object') return;
        viewQueueRef.current = Object.assign({}, viewQueueRef.current || {}, patch);
        viewQueueSpaceRef.current = canvasActive() ? 'canvas' : 'scroll';
        if (viewTimerRef.current) window.clearTimeout(viewTimerRef.current);
        // 输入框编辑沿用 120ms 合并；拖拽写入以 0ms 立即入队（面板已按 PAN_WRITE_THROTTLE_MS 节流）。
        const wait = Number.isFinite(Number(delayMs)) ? Math.max(0, Number(delayMs)) : VIEW_DEBOUNCE_MS;
        viewTimerRef.current = window.setTimeout(() => { flushViewPatch(); }, wait);
      }

      /**
       * Send the merged patch. A new Host gets the v1 body (`version`/`expectedRevision`, per-field
       * patch); an old Host keeps the legacy `{width,height}` body and its old semantics.
       */
      async function flushViewPatch() {
        viewTimerRef.current = 0;
        const patch = viewQueueRef.current;
        viewQueueRef.current = null;
        const queuedSpace = viewQueueSpaceRef.current;
        viewQueueSpaceRef.current = null;
        if (!patch) return;
        const isZoomPatch = patch.scale !== undefined && (patch.x !== undefined || patch.y !== undefined);
        if (isZoomPatch) zoomDebug('flush', { patch, inFlight: viewInFlightRef.current });
        if (viewInFlightRef.current) {
          viewQueuedRef.current = Object.assign({}, viewQueuedRef.current || {}, patch);
          viewQueuedSpaceRef.current = queuedSpace;
          if (isZoomPatch) zoomDebug('queue-while-inflight', { patch });
          return;
        }
        if (!readyRef.current) return;
        const accepted = viewRef.current;
        const scopeNow = scopeRef.current;
        const signal = abortRef.current ? abortRef.current.signal : undefined;
        const body = {};
        if (accepted) {
          body.version = 1;
          if (Number.isFinite(Number(accepted.revision))) body.expectedRevision = Number(accepted.revision);
          // The draft/queue keeps the historical field names (`x`/`y`) so wheel/drag/commit share
          // one path; the wire field follows the coordinate space captured when the patch was
          // queued. A canvas Host gets `canvasX/canvasY`, an old Host keeps document scroll `x/y`.
          const canvasMode = queuedSpace === 'canvas';
          for (const [field, value] of Object.entries(patch)) {
            if (canvasMode && field === 'x') body.canvasX = value;
            else if (canvasMode && field === 'y') body.canvasY = value;
            else body[field] = value;
          }
        } else {
          body.width = Number.isFinite(Number(patch.width)) ? Number(patch.width) : pageSize.w;
          body.height = Number.isFinite(Number(patch.height)) ? Number(patch.height) : pageSize.h;
        }
        const submitted = {};
        for (const field of Object.keys(patch)) submitted[field] = viewEditRef.current[field];
        viewInFlightRef.current = true;
        try {
          const payload = await callHost('viewport', body, { scope: scopeNow, signal });
          // The response carries the canvas projection too: adopt it before the view it describes so
          // the X/Y drafts and the composited displacement never lag a settled canvas set.
          if (payload && (payload.state || payload.ui)) adoptCanvas(canvasOf(payload));
          if (payload && payload.view) {
            selfViewRevisionRef.current = Number(payload.view.revision);
            adoptView(payload.view, payload.viewMeta, payload.observed);
          }
          if (payload && payload.state) ingestHostState(payload.state);
          for (const field of Object.keys(submitted)) {
            if (viewEditRef.current[field] === submitted[field]) viewDirtyRef.current[field] = null;
          }
          clearSettledWheelDrafts(submitted);
          syncViewDrafts();
          const intent = zoomIntentRef.current;
          if (isZoomPatch) zoomDebug('success', { patch, viewScale: payload && payload.view ? payload.view.scale : null, intentScale: intent.scale });
          if (isZoomPatch && intent.scale !== null && Math.abs(Number(intent.scale) - Number(patch.scale)) <= 0.0011) {
            clearZoomIntent('zoom-success');
          }
          zoomRetryRef.current = 0;
        } catch (error) {
          if (error && error.name === 'AbortError') return;
          const zoomTarget = activeZoomIntent();
          const code = error && error.code ? String(error.code) : '';
          // A revision conflict keeps a *typed* draft (the user must resubmit it explicitly) but a
          // rejected wheel notch is not a draft: showing a value the Host never accepted would lie
          // about the shared view, so that field snaps back to the accepted truth.
          const payload = error && error.payload ? error.payload : null;
          const details = payload && payload.details && typeof payload.details === 'object' ? payload.details : null;
          const conflictView = (details && details.view)
            || (payload && payload.view && typeof payload.view === 'object' ? payload.view : null)
            || (payload && payload.state && payload.state.ui && payload.state.ui.view ? payload.state.ui.view : null)
            || null;
          if (conflictView) {
            selfViewRevisionRef.current = Number(conflictView.revision);
            adoptView(conflictView, undefined, undefined);
          }
          clearSettledWheelDrafts(submitted);
          if (code) logViewReject(code);
          syncViewDrafts();
          // Zoom is an incremental interaction: a CAS conflict must replay THIS notch from the
          // latest accepted view (bounded to one retry) instead of losing it. Absolute x/y/scale
          // targets are queued again; the retry uses the freshly adopted revision.
          if (isZoomPatch) zoomDebug('catch', { code, isZoomPatch, targetScale: zoomTarget ? zoomTarget.scale : null, retry: zoomRetryRef.current, patch });
          if (code === 'VIEWPORT_CONFLICT' && isZoomPatch && zoomTarget && zoomRetryRef.current < 1) {
            zoomRetryRef.current += 1;
            zoomDebug('retry', { targetScale: zoomTarget.scale, targetX: zoomTarget.x, targetY: zoomTarget.y });
            const restored = { scale: zoomTarget.scale, x: zoomTarget.x, y: zoomTarget.y, w: zoomTarget.w, h: zoomTarget.h, at: Date.now() };
            canvasZoomRef.current = restored;
            zoomIntentRef.current = restored;
            const retryPercent = Math.round(Number(zoomTarget.scale) * 100);
            setZoom(String(retryPercent));
            noteViewEdit('scale', retryPercent);
            viewWheelRef.current.scale = viewEditRef.current.scale;
            queueViewPatch({ scale: zoomTarget.scale, x: zoomTarget.x, y: zoomTarget.y }, 0);
          } else {
            const intent = zoomIntentRef.current;
            if (!isZoomPatch || intent.scale === null || Math.abs(Number(intent.scale) - Number(patch.scale)) <= 0.0011) {
              clearZoomIntent('zoom-catch');
            }
          }
        } finally {
          viewInFlightRef.current = false;
          if (viewQueuedRef.current) {
            viewQueueRef.current = Object.assign({}, viewQueueRef.current || {}, viewQueuedRef.current);
            viewQueueSpaceRef.current = viewQueuedSpaceRef.current;
            viewQueuedRef.current = null;
            viewQueuedSpaceRef.current = null;
            flushViewPatch();
          }
        }
      }

      /**
       * 拖拽视口（用户 2026-11-02 要求，P0-C v2 语义）：勾选「拖拽」后，按住画面拖动按“内容跟手”
       * 方向平移**画布原点 C**（向右/下拖 → canvasX/canvasY 减小），可进入负值；最终值仍由 Host
       * 实测读回决定（允许越出内容区，不再 clamp 到滚动范围）。写入与输入框共用同一条 v1/CAS
       * 请求路径；本面板额外按 PAN_WRITE_THROTTLE_MS 合并移动事件，同一次 drag 内最多一个 set
       * 在途，避免洪泛队列。关闭拖拽后不向页面补发任何鼠标事件，用户可继续正常点击/拖拽页面。
       */
      function panWriteLatest(latest) {
        if (!latest || !viewRef.current || !canvasActive()) return;
        queueViewPatch({ x: roundCanvas(latest.x), y: roundCanvas(latest.y) }, 0);
      }

      function requestPanWrite(x, y) {
        const state = panWriteRef.current;
        state.latest = { x, y };
        if (state.timer) return;
        state.timer = window.setTimeout(() => {
          state.timer = 0;
          const latest = state.latest;
          state.latest = null;
          panWriteLatest(latest);
        }, PAN_WRITE_THROTTLE_MS);
      }

      function flushPanWrite() {
        const state = panWriteRef.current;
        if (state.timer) {
          window.clearTimeout(state.timer);
          state.timer = 0;
        }
        const latest = state.latest;
        state.latest = null;
        panWriteLatest(latest);
      }

      function cancelPanDrag() {
        const pan = panDragRef.current;
        if (!pan.active) return;
        panDragRef.current = {
          active: false, pointerId: -1, startClientX: 0, startClientY: 0,
          startX: 0, startY: 0, geom: null, viewW: 0, viewH: 0,
        };
        setPanDragging(false);
      }

      function changePanMode(next) {
        const on = Boolean(next);
        if (on && annotRef.current.on) return; // annotation mode forbids drag mode
        if (on && pickRef.current.on) return; // element pick mode forbids drag mode
        if (on && !canvasActive()) return; // old Host / no canvas: drag stays disabled
        panModeRef.current = on;
        setPanMode(on);
        if (!on) {
          cancelPanDrag();
          flushPanWrite();
          clearZoomIntent();
          resetZoomAnchor();
        }
      }

      /** Closing the size bar must also leave drag mode, otherwise the pointer stays a grab hand. */
      function toggleSizing() {
        if (annotRef.current.on || pickRef.current.on) return;
        const next = !sizing;
        sizingRef.current = next; // same tick: enterAnnotMode must never observe a stale false
        setSizing(next);
        if (!next) changePanMode(false);
      }

      /* ----------------------------------------------------------------------------------------
       * P0-D 标注模式（docs/viewport-control.md）
       *
       * The layer is a panel-local SVG view over the accepted canvas space:
       *   P  = paintedRect(box, naturalW/H)      // never the translated <img>
       *   d  = (C + (clientX-P.left)/sx, ...)    // canvas CSS px
       *   screen(d) = (P.left + (d.x-C)*sx, ...)
       * It never mutates the target page, never enters Host screenshots/T3 and never persists.
       * The active gesture keeps its frozen mapping in a ref and paints one imperative draft node
       * per animation frame; only a committed shape is copied into React state.
       * -------------------------------------------------------------------------------------- */

      /** Immutable snapshot of the current annotation tool/style (style is frozen at stroke start). */
      function annotSnapshot() {
        const current = annotRef.current;
        return { tool: current.tool, color: current.color, width: current.width, fill: current.fill, stroke: current.stroke };
      }

      function annotIsClosedTool(tool) {
        return tool === 'circle' || tool === 'rect';
      }

      /**
       * Current painted mapping of the annotation layer. The SVG must cover the *untranslated*
       * painted rect (the <img> itself may be translated by canvas compositing), so this never reads
       * `frameShift`/`seedClip`.
       */
      function annotMap() {
        const img = frameImgRef.current;
        const box = frameBoxRef.current;
        if (!img || !box) return null;
        const boxRect = box.getBoundingClientRect();
        const painted = paintedRect(boxRect, img.naturalWidth, img.naturalHeight);
        if (!painted) return null;
        const canvas = canvasPosition();
        const size = acceptedViewSize();
        if (!canvas || !(size.w > 0) || !(size.h > 0)) return null;
        const sx = painted.width / size.w;
        const sy = painted.height / size.h;
        if (!(sx > 0) || !(sy > 0)) return null;
        return { painted, boxRect, cx: canvas.x, cy: canvas.y, w: size.w, h: size.h, sx, sy };
      }

      function annotMapSignature(map) {
        if (!map) return '';
        const round = (value) => Math.round(Number(value) * 100) / 100;
        return [map.painted.left, map.painted.top, map.painted.width, map.painted.height, map.cx, map.cy, map.w, map.h]
          .map(round).join('|');
      }

      /** Pointer → canvas CSS px through one frozen mapping, clamped to the captured view rect. */
      function annotToCanvas(map, clientX, clientY) {
        return {
          x: clampNumber(map.cx + (clientX - map.painted.left) / map.sx, map.cx, map.cx + map.w),
          y: clampNumber(map.cy + (clientY - map.painted.top) / map.sy, map.cy, map.cy + map.h),
        };
      }

      /** Half-open painted rect: the letterbox is not a drawable surface. */
      function annotInside(map, clientX, clientY) {
        return clientX >= map.painted.left && clientX < map.painted.left + map.painted.width
          && clientY >= map.painted.top && clientY < map.painted.top + map.painted.height;
      }

      function annotScreenPoint(map, point) {
        return {
          x: map.painted.left + (point.x - map.cx) * map.sx,
          y: map.painted.top + (point.y - map.cy) * map.sy,
        };
      }

      /* ---- v3 工作区文档：水合 / 保留队列 / 发布者身份（docs/viewport-control.md）------------ */

      function annotSurfaceName() {
        return props && typeof props.useTabInfo === 'function' ? 'sidebar' : 'main';
      }

      function annotUiNow() {
        const accepted = remoteRef.current;
        return accepted && accepted.ui && accepted.ui.version === 1 ? accepted.ui : null;
      }

      /** Accepted Host annotation context (`ui.annotationContext`); null on an old Host. */
      function annotContextNow() {
        const ui = annotUiNow();
        const context = ui && ui.annotationContext;
        return context && typeof context === 'object' ? context : null;
      }

      /** D = (authenticated scope.id, runtimeId, documentKey, pageGeneration, documentEpoch). */
      function annotDOf(ui) {
        const context = ui && ui.annotationContext;
        const scopeId = ui && ui.scope && ui.scope.id ? String(ui.scope.id) : '';
        if (!context || typeof context !== 'object' || !scopeId) return null;
        if (!context.runtimeId || !context.documentKey) return null;
        return {
          scopeId,
          runtimeId: String(context.runtimeId),
          documentKey: String(context.documentKey),
          pageGeneration: context.pageGeneration === undefined ? null : context.pageGeneration,
          documentEpoch: context.documentEpoch === undefined ? null : context.documentEpoch,
        };
      }

      function annotDKey(d) {
        return d ? [d.scopeId, d.runtimeId, d.documentKey, d.pageGeneration, d.documentEpoch].join('|') : '';
      }

      function annotContextMatches(a, b) {
        if (!a || !b) return false;
        return ['runtimeId', 'documentKey', 'pageGeneration', 'documentEpoch', 'addressDigest']
          .every((name) => String(a[name] === undefined ? '' : a[name]) === String(b[name] === undefined ? '' : b[name]));
      }

      /** The accepted view as the panel currently sees it (a snapshot, not the live truth). */
      function annotViewSnapshot() {
        const view = viewRef.current;
        const canvas = canvasPosition();
        const size = acceptedViewSize();
        const scroll = observedScroll();
        const number = (value, fallback) => (Number.isFinite(Number(value)) ? Number(value) : fallback);
        const round2 = (value) => Math.round(value * 100) / 100;
        const canvasX = canvas ? number(canvas.x, 0) : (view ? number(view.canvasX, 0) : 0);
        const canvasY = canvas ? number(canvas.y, 0) : (view ? number(view.canvasY, 0) : 0);
        const scale = Math.min(2, Math.max(0.1, view ? number(view.scale, 1) : 1));
        const epoch = annotEpochRef.current;
        return {
          canvasX,
          canvasY,
          x: round2(scroll.x),
          y: round2(scroll.y),
          width: Math.round(Math.min(4096, Math.max(200, size.w))),
          height: Math.round(Math.min(4096, Math.max(200, size.h))),
          scale,
          contentWidth: canvas && Number.isFinite(Number(canvas.contentWidth)) ? Number(canvas.contentWidth) : null,
          contentHeight: canvas && Number.isFinite(Number(canvas.contentHeight)) ? Number(canvas.contentHeight) : null,
          viewRevision: view ? Math.max(0, Math.round(number(view.revision, 0))) : 0,
          frameEpoch: epoch === null || epoch === undefined || !Number.isFinite(Number(epoch))
            ? null : Math.max(0, Math.round(Number(epoch))),
        };
      }

      function annotHexColor(value) {
        const text = String(value === undefined || value === null ? '' : value).trim().toLowerCase();
        return /^#[0-9a-f]{6}$/.test(text) ? text : ANNOT_DEFAULT.color;
      }

      /** Local shape → Host wire shape (§11.2): exactly the whitelisted fields, no extras. */
      function annotWireShape(shape) {
        const color = annotHexColor(shape.color);
        const strokeWidth = Math.max(1, Math.min(20, Math.round(Number(shape.strokeWidth) || 1)));
        const common = {
          id: shape.id,
          type: shape.type,
          color,
          strokeWidth,
          fill: Boolean(shape.fill),
          stroke: Boolean(shape.stroke),
        };
        if (shape.type === 'rect') {
          return Object.assign(common, { x: shape.x, y: shape.y, width: shape.w, height: shape.h });
        }
        if (shape.type === 'circle') {
          return Object.assign(common, { cx: shape.cx, cy: shape.cy, rx: shape.rx, ry: shape.ry });
        }
        if (shape.type === 'line') {
          return Object.assign(common, { x1: shape.x1, y1: shape.y1, x2: shape.x2, y2: shape.y2 });
        }
        if (shape.type === 'arrow') {
          // The Host recomputes the head; sending the same deterministic values keeps both ends equal.
          const length = Math.hypot(shape.x2 - shape.x1, shape.y2 - shape.y1);
          return Object.assign(common, {
            x1: shape.x1, y1: shape.y1, x2: shape.x2, y2: shape.y2,
            head: { length: Math.min(3 * strokeWidth, length), width: Math.min(2 * strokeWidth, length) },
          });
        }
        if (shape.type === 'brush') {
          return Object.assign(common, { points: (shape.points || []).map((point) => [point.x, point.y]) });
        }
        if (shape.type === 'text') {
          return Object.assign(common, { x: shape.x, y: shape.y, fontSize: 20, text: String(shape.text || '') });
        }
        return null;
      }

      /**
       * Host wire shape → local shape (§12.2): deep copy, keep order/id/style, rect `width/height`
       * become local `w/h`, brush `[[x,y]]` becomes `{x,y}`; geometry is already canvas CSS px and
       * is never re-scaled. Invalid/foreign entries are dropped instead of guessed.
       */
      function annotWireToLocal(wire) {
        if (!wire || typeof wire !== 'object') return null;
        const type = wire.type;
        if (!['circle', 'rect', 'line', 'arrow', 'brush', 'text'].includes(type)) return null;
        if (typeof wire.id !== 'string' || !ANNOT_ID_PATTERN.test(wire.id)) return null;
        const rawWidth = Number(wire.strokeWidth);
        if (!Number.isFinite(rawWidth)) return null;
        const common = {
          id: wire.id,
          type,
          color: annotHexColor(wire.color),
          strokeWidth: Math.max(1, Math.min(20, Math.round(rawWidth))),
          fill: wire.fill === true,
          stroke: wire.stroke === true,
        };
        const num = (value) => (Number.isFinite(Number(value)) ? Number(value) : null);
        if (type === 'rect') {
          const x = num(wire.x);
          const y = num(wire.y);
          const w = num(wire.width);
          const h = num(wire.height);
          if (x === null || y === null || !(w > 0) || !(h > 0)) return null;
          return Object.assign(common, { x, y, w, h });
        }
        if (type === 'circle') {
          const cx = num(wire.cx);
          const cy = num(wire.cy);
          const rx = num(wire.rx);
          const ry = num(wire.ry);
          if (cx === null || cy === null || !(rx > 0) || !(ry > 0)) return null;
          return Object.assign(common, { cx, cy, rx, ry });
        }
        if (type === 'line' || type === 'arrow') {
          const x1 = num(wire.x1);
          const y1 = num(wire.y1);
          const x2 = num(wire.x2);
          const y2 = num(wire.y2);
          if (x1 === null || y1 === null || x2 === null || y2 === null) return null;
          return Object.assign(common, { x1, y1, x2, y2, fill: false, stroke: true });
        }
        if (type === 'brush') {
          const points = Array.isArray(wire.points)
            ? wire.points
              .filter((pair) => Array.isArray(pair) && pair.length === 2
                && Number.isFinite(Number(pair[0])) && Number.isFinite(Number(pair[1])))
              .map((pair) => ({ x: Number(pair[0]), y: Number(pair[1]) }))
            : [];
          if (points.length < 2) return null;
          return Object.assign(common, { points, fill: false, stroke: true });
        }
        const x = num(wire.x);
        const y = num(wire.y);
        if (x === null || y === null || typeof wire.text !== 'string') return null;
        return Object.assign(common, { x, y, text: wire.text, fill: true, stroke: false });
      }

      /** Replace the visible committed set with an imported Host/retained set (ids stay unique). */
      function annotApplyImported(wireShapes) {
        const imported = [];
        let maxId = 0;
        const previousWatermark = annotNextIdRef.current;
        for (const wire of Array.isArray(wireShapes) ? wireShapes : []) {
          const local = annotWireToLocal(wire);
          if (!local) continue;
          imported.push(local);
          const match = ANNOT_ID_PATTERN.exec(local.id);
          if (match) maxId = Math.max(maxId, Number(match[1]));
        }
        annotShapesRef.current = imported;
        annotPruneSelection();
        const safeWatermark = Number.isSafeInteger(previousWatermark) && previousWatermark >= 0 ? previousWatermark : 0;
        const safeMaxId = Number.isSafeInteger(maxId) && maxId >= 0 ? maxId : 0;
        annotNextIdRef.current = Math.max(safeWatermark, safeMaxId);
        setAnnotVersion((value) => value + 1);
      }

      /**
       * Local committed shapes → the normalized document plus the client-side truncation, using the
       * same deterministic rules as the Host (§11.2): keep the newest 128 shapes, downsample brushes
       * to 512 points preserving first/last, drop the oldest whole shapes for the point/byte budget.
       */
      function annotNormalize() {
        const truncation = { droppedShapes: 0, droppedPoints: 0, shortenedTextCodeUnits: 0 };
        let shapes = [];
        for (const local of annotShapesRef.current) {
          let working = local;
          if (local.type === 'text') {
            const text = String(local.text === undefined || local.text === null ? '' : local.text);
            let clipped = text.length > ANNOT_LIMITS.textChars ? text.slice(0, ANNOT_LIMITS.textChars) : text;
            // Never split a surrogate pair at the cap.
            if (/[\uD800-\uDBFF]$/.test(clipped)) clipped = clipped.slice(0, -1);
            if (clipped !== text) {
              truncation.shortenedTextCodeUnits += text.length - clipped.length;
              working = Object.assign({}, local, { text: clipped });
            }
          }
          const wire = annotWireShape(working);
          if (wire) shapes.push(wire);
        }
        if (shapes.length > ANNOT_LIMITS.shapes) {
          truncation.droppedShapes += shapes.length - ANNOT_LIMITS.shapes;
          shapes = shapes.slice(shapes.length - ANNOT_LIMITS.shapes);
        }
        shapes = shapes.map((shape) => {
          if (shape.type !== 'brush' || shape.points.length <= ANNOT_LIMITS.brushPoints) return shape;
          const count = shape.points.length;
          const points = [];
          for (let index = 0; index < ANNOT_LIMITS.brushPoints; index += 1) {
            points.push(shape.points[Math.round((index * (count - 1)) / (ANNOT_LIMITS.brushPoints - 1))]);
          }
          truncation.droppedPoints += count - points.length;
          return Object.assign({}, shape, { points });
        });
        const pointsOf = (list) => list.reduce((total, shape) => total + (shape.type === 'brush' ? shape.points.length : 0), 0);
        const encoder = typeof TextEncoder === 'function' ? new TextEncoder() : null;
        const bytesOf = (list) => {
          try {
            const text = JSON.stringify({ version: 1, shapes: list, truncation });
            return encoder ? encoder.encode(text).length : text.length;
          } catch { return 0; }
        };
        let guard = 0;
        while (shapes.length > 0 && (pointsOf(shapes) > ANNOT_LIMITS.documentPoints || bytesOf(shapes) > ANNOT_LIMITS.bytes)) {
          shapes.shift();
          truncation.droppedShapes += 1;
          guard += 1;
          if (guard > 200) break;
        }
        return { shapes, truncation };
      }

      function annotSetSyncState(state) {
        annotSyncRef.current.state = state;
        const revision = annotShownRevisionRef.current;
        setAnnotSync((current) => (current.state === state && current.revision === revision
          ? current : { state, revision }));
      }

      /** Stale metadata is read-time only: a change must re-render the hint but never move revisions. */
      function annotSetStale(stale, reason) {
        const next = { stale: stale === true, staleReason: reason || null };
        const previous = annotStaleRef.current;
        if (previous.stale === next.stale && previous.staleReason === next.staleReason) return;
        annotStaleRef.current = next;
        setAnnotStaleState(next);
      }

      /** ACK / 409 / failure events from the module queue, guarded by mount generation + scope + D. */
      function annotPublisherEvent(event) {
        const snapshot = event && event.snapshot;
        if (!snapshot) return;
        if (snapshot.mountGeneration !== annotMountGenerationRef.current) return;
        if (snapshot.scopeEpoch !== scopeEpochRef.current) return;
        const gate = annotGateRef.current;
        if (!gate.open || snapshot.dKey !== gate.key) return;
        if (event.type === 'ack') {
          const accepted = event.annotations;
          const revision = accepted && Number.isSafeInteger(Number(accepted.revision))
            ? Math.max(0, Number(accepted.revision)) : null;
          if (accepted && revision !== null) {
            gate.revision = Math.max(gate.revision, revision);
            annotSetStale(accepted.stale, accepted.staleReason);
          }
          if (snapshot.contentSeq === annotContentSeqRef.current) {
            // The final ACK's normalized document (including Host truncation) is the visible truth.
            if (accepted && Array.isArray(accepted.shapes)) {
              // An ACK for the previous edit must not replace the geometry under a held pointer.
              // Reconcile Host normalization/truncation when this move finishes or is cancelled.
              if (annotMoveRef.current.active) annotMoveRef.current.acceptedShapes = accepted.shapes;
              else annotApplyImported(accepted.shapes);
              annotDirtyRef.current = false;
            }
            if (revision !== null) annotShownRevisionRef.current = Math.max(annotShownRevisionRef.current, revision);
            annotSetSyncState('synced');
            annotMaybeAdoptCandidate();
          } else {
            annotSetSyncState('pending');
          }
          return;
        }
        if (event.type === 'error') {
          annotSetSyncState(event.final ? 'error' : 'pending');
          return;
        }
        if (event.type === 'stale') {
          // 409: this document's local content is stale; drop it and let the next accepted state
          // hydrate the rotated key. Another workspace's publisher/document is never touched.
          annotDropLocalView({ exit: false, discard: true });
        }
      }

      function annotSubscribePublisher(entry, key) {
        if (annotPublisherRef.current === entry && annotUnsubRef.current && annotGateRef.current.key === key) return;
        annotUnsubscribePublisher();
        annotPublisherRef.current = entry;
        annotUnsubRef.current = annotPublisherSubscribe(entry, annotPublisherEvent);
      }

      function annotUnsubscribePublisher() {
        if (annotUnsubRef.current) annotUnsubRef.current();
        annotUnsubRef.current = null;
      }

      /** The current publishing identity; null until the new scope's first trusted state opens the gate. */
      function annotIdentityNow(options) {
        const anyEpoch = Boolean(options && options.anyEpoch);
        const gate = annotGateRef.current;
        if (!gate.open || !gate.key) return null;
        if (!anyEpoch && gate.epoch !== scopeEpochRef.current) return null;
        // The currently accepted snapshot must still prove the same document/context (a vanished
        // `ui.annotationContext` or a rotated token must stop publishing immediately).
        const currentD = annotDOf(annotUiNow());
        if (!currentD || annotDKey(currentD) !== gate.key) return null;
        const entry = annotPublisherRef.current;
        if (!entry) return null;
        return {
          entry,
          dKey: gate.key,
          d: gate.d,
          context: Object.assign({}, gate.context),
          scope: gate.scope,
          // Cross-generation retains (scope change/unmount) must not read the new scope's view.
          view: anyEpoch ? (gate.view || annotViewSnapshot()) : annotViewSnapshot(),
        };
      }

      function annotBuildSnapshot(identity, normalized) {
        const entry = identity.entry;
        return {
          entryKey: entry.key,
          panelId: entry.panelId,
          surface: entry.surface,
          clientRevision: annotPublisherAllocate(entry),
          context: Object.assign({}, identity.context),
          scope: identity.scope,
          view: identity.view || annotViewSnapshot(),
          shapes: normalized.shapes,
          truncation: normalized.truncation,
          release: false,
          dKey: identity.dKey,
          contentSeq: annotContentSeqRef.current,
          mountGeneration: annotMountGenerationRef.current,
          scopeEpoch: scopeEpochRef.current,
        };
      }

      /** 150ms trailing merge for commit/文字提交/每次擦除（§11.3）. */
      function annotPublishSchedule() {
        if (!readyRef.current || !annotDirtyRef.current) return;
        const identity = annotIdentityNow();
        if (!identity) return;
        const store = annotSyncRef.current;
        if (store.timer) window.clearTimeout(store.timer);
        store.timer = window.setTimeout(() => {
          store.timer = 0;
          annotPublishNow();
        }, ANNOT_PUBLISH_DEBOUNCE_MS);
        annotSetSyncState('pending');
      }

      /** Freeze identity + normalized shapes and enqueue as the newest snapshot (at most 1 waiting). */
      function annotPublishNow() {
        // An older edit's debounce may fire during a new move. Only publish committed geometry.
        if (annotMoveRef.current.active) return null;
        const identity = annotIdentityNow();
        if (!identity) return null;
        const normalized = annotNormalize();
        const snapshot = annotBuildSnapshot(identity, normalized);
        annotPublisherQueue(identity.entry, snapshot);
        annotSetSyncState('pending');
        return snapshot;
      }

      /** Exit/flush: only genuinely dirty content is sent; a clean panel performs zero POSTs (§12.1). */
      function annotFlushPending() {
        const store = annotSyncRef.current;
        if (store.timer) {
          window.clearTimeout(store.timer);
          store.timer = 0;
        }
        if (annotDirtyRef.current) {
          annotPublishNow();
          return;
        }
        const entry = annotPublisherRef.current;
        if (entry) annotPublisherDrain(entry);
      }

      /**
       * Hand unconfirmed committed content to the module queue under the *old* frozen identity.
       * `flush` publishes it now (scope change / unmount); without `flush` it is only remembered
       * (capability temporarily unavailable). It is never converted into an empty document.
       */
      function annotRetainDirty(flush) {
        // Retained content is committed content; a scope/runtime change cancels a held move first.
        cancelAnnotMove();
        if (!annotDirtyRef.current) return;
        const normalized = annotNormalize();
        const identity = annotIdentityNow({ anyEpoch: true });
        if (!identity) {
          const entry = annotPublisherRef.current;
          if (entry) {
            annotPublisherRemember(entry, {
              shapes: normalized.shapes,
              truncation: normalized.truncation,
              contentSeq: annotContentSeqRef.current,
              dKey: annotGateRef.current.key,
            });
          }
          annotDirtyRef.current = false;
          return;
        }
        if (flush) annotPublisherQueue(identity.entry, annotBuildSnapshot(identity, normalized));
        else {
          annotPublisherRemember(identity.entry, {
            shapes: normalized.shapes,
            truncation: normalized.truncation,
            contentSeq: annotContentSeqRef.current,
            dKey: identity.dKey,
          });
        }
        annotDirtyRef.current = false;
      }

      /**
       * Retract this panel's local view only: no release, no empty document, no POST. The gate is
       * closed so old shapes are neither rendered nor published until a trusted state re-opens it.
       */
      function annotDropLocalView(options) {
        const exit = Boolean(options && options.exit);
        const discard = Boolean(options && options.discard);
        annotCancelTransient();
        setAnnotText(null);
        resetAnnotErase();
        setAnnotBusy(false);
        annotShapesRef.current = [];
        annotSelectionRef.current = new Set();
        annotCandidateRef.current = null;
        setAnnotVersion((value) => value + 1);
        annotDirtyRef.current = false;
        annotContentSeqRef.current += 1;
        const gate = annotGateRef.current;
        if (discard) {
          // A navigation/rotated token intentionally ends this document: its unconfirmed queue is
          // dropped too (never replayed into the new key).
          const entry = annotPublisherRef.current;
          if (entry) {
            if (entry.queued && entry.queued.dKey === gate.key) entry.queued = null;
            if (entry.pendingDKey === gate.key) {
              entry.dirty = false;
              entry.pendingShapes = null;
              entry.pendingTruncation = null;
            }
          }
        }
        if (annotSyncRef.current.timer) {
          window.clearTimeout(annotSyncRef.current.timer);
          annotSyncRef.current.timer = 0;
        }
        gate.open = false;
        gate.key = '';
        gate.revision = -1;
        gate.context = null;
        gate.d = null;
        gate.scope = null;
        if (exit) {
          annotRef.current.on = false;
          setAnnotOn(false);
        }
        annotSetSyncState('idle');
      }

      /**
       * Local navigation (§12.1): clear locally *and* submit a normal empty document under the old
       * frozen identity; the old content queue is dropped (nothing is replayed into the new key).
       */
      function annotNavigationClear() {
        const identity = annotIdentityNow({ anyEpoch: true });
        annotCancelTransient();
        setAnnotText(null);
        resetAnnotErase();
        setAnnotBusy(false);
        annotShapesRef.current = [];
        annotSelectionRef.current = new Set();
        annotCandidateRef.current = null;
        setAnnotVersion((value) => value + 1);
        annotDirtyRef.current = false;
        annotContentSeqRef.current += 1;
        if (identity) {
          const snapshot = annotBuildSnapshot(identity, {
            shapes: [], truncation: { droppedShapes: 0, droppedPoints: 0, shortenedTextCodeUnits: 0 },
          });
          identity.entry.queued = null;
          annotPublisherQueue(identity.entry, snapshot);
        }
        const gate = annotGateRef.current;
        gate.open = false;
        gate.key = '';
        gate.revision = -1;
        gate.context = null;
        gate.d = null;
        gate.scope = null;
        annotSetSyncState('idle');
      }

      /** Clean + no gesture/edit/in-flight/error → a newer Host revision may replace the view. */
      function annotCanAdopt() {
        if (annotDirtyRef.current) return false;
        if (annotGestureRef.current.active || annotEditRef.current.active || annotEraseRef.current.active
          || annotMoveRef.current.active || annotMarqueeRef.current.active) return false;
        const entry = annotPublisherRef.current;
        if (!entry) return false;
        if (entry.inflight || entry.queued || entry.lastError) return false;
        const state = annotSyncRef.current.state;
        return state !== 'pending' && state !== 'error';
      }

      function annotMaybeAdoptCandidate() {
        const candidate = annotCandidateRef.current;
        if (!candidate) return;
        const gate = annotGateRef.current;
        if (!gate.open || candidate.dKey !== gate.key) {
          annotCandidateRef.current = null;
          return;
        }
        if (!annotCanAdopt()) return;
        if (candidate.revision <= gate.revision) {
          annotCandidateRef.current = null;
          return;
        }
        gate.revision = candidate.revision;
        annotApplyImported(candidate.shapes);
        annotDirtyRef.current = false;
        annotShownRevisionRef.current = Math.max(annotShownRevisionRef.current, candidate.revision);
        annotSetStale(candidate.stale, candidate.staleReason);
        annotSetSyncState('synced');
        annotCandidateRef.current = null;
      }

      /**
       * Hydrate `ui.annotations` after runtime/revision/view acceptance (§12.2). The document is
       * located by the same-response context, never by sessionId or by "most recent" guessing.
       */
      function annotHydrate(ui) {
        const gate = annotGateRef.current;
        if (gate.epoch !== scopeEpochRef.current) return;
        const scopeNow = scopeRef.current;
        if (!scopeNow || scopeNow.legacy) return;
        const doc = ui && ui.annotations;
        const context = ui && ui.annotationContext;
        const d = annotDOf(ui);
        if (!doc || typeof doc !== 'object' || !d) return;
        if (doc.version !== 1 || doc.space !== 'canvas-css-px') return;
        const revision = Number(doc.revision);
        if (!Number.isSafeInteger(revision) || revision < 0) return;
        const shapes = Array.isArray(doc.shapes) ? doc.shapes : [];
        const key = annotDKey(d);
        // A non-empty document must cite exactly the authenticated context (including addressDigest).
        if (shapes.length > 0 && !annotContextMatches(doc.context, context)) {
          if (gate.open && gate.key !== key) annotDropLocalView({ exit: false });
          return;
        }
        const entry = annotPublisherGet(d.scopeId, d.runtimeId, annotSurfaceName());
        // The Host watermark must not be exceeded after a reload/remount (§12.4).
        if (doc.source && doc.source.panelId === entry.panelId
          && Number.isSafeInteger(Number(doc.source.clientRevision))) {
          const watermark = Math.max(0, Number(doc.source.clientRevision));
          if (watermark > entry.clientRevision) {
            entry.clientRevision = watermark;
            annotPublisherPersist(entry);
          }
        }
        annotSetStale(doc.stale, doc.staleReason);
        const viewSnapshot = annotViewSnapshot();
        const firstForDocument = !gate.open || gate.key !== key;
        if (firstForDocument) {
          annotSubscribePublisher(entry, key);
          gate.open = true;
          gate.key = key;
          gate.revision = revision;
          gate.epoch = scopeEpochRef.current;
          gate.context = Object.assign({}, context);
          gate.d = d;
          gate.scope = scopeNow;
          gate.view = viewSnapshot;
          entry.activeDKey = key;
          entry.activeGeneration = annotMountGenerationRef.current;
          entry.activeEpoch = scopeEpochRef.current;
          if (entry.dirty && entry.pendingDKey === key && Array.isArray(entry.pendingShapes)) {
            // A remount of the same D resumes the unconfirmed content (dirty/error), not the Host copy.
            annotApplyImported(entry.pendingShapes);
            annotDirtyRef.current = true;
            annotContentSeqRef.current = Math.max(annotContentSeqRef.current, entry.pendingContentSeq);
            annotShownRevisionRef.current = Math.max(entry.hostRevision, 0);
            annotSetSyncState(entry.lastError ? 'error' : 'pending');
            return;
          }
          annotApplyImported(shapes);
          annotDirtyRef.current = false;
          annotShownRevisionRef.current = revision;
          annotSetSyncState('synced');
          return;
        }
        gate.view = viewSnapshot;
        if (revision > gate.revision) {
          if (annotCanAdopt()) {
            gate.revision = revision;
            annotApplyImported(shapes);
            annotDirtyRef.current = false;
            annotShownRevisionRef.current = revision;
            if (annotCandidateRef.current && annotCandidateRef.current.revision <= revision) {
              annotCandidateRef.current = null;
            }
            if (!annotSyncRef.current.timer && !entry.inflight && !entry.queued && !entry.lastError) {
              annotSetSyncState('synced');
            }
          } else {
            annotCandidateRef.current = {
              dKey: key,
              revision,
              shapes,
              stale: doc.stale === true,
              staleReason: doc.staleReason || null,
            };
          }
        }
      }

      /** Pick up a newer candidate once a gesture/edit/cancel or ACK made the panel clean again. */
      function annotResumeAfterTransient() {
        window.setTimeout(() => {
          annotMaybeAdoptCandidate();
          if (annotChannelRef.current && annotDirtyRef.current && annotGateRef.current.open) annotPublishSchedule();
        }, 0);
      }

      /* ---- 橡皮擦（docs/viewport-control.md）------------------------------------------- */

      function annotEraseRadius(shape) {
        const width = Number(shape.strokeWidth);
        return Math.max(Number.isFinite(width) ? width / 2 : 0, ANNOT_ERASE_MIN_RADIUS);
      }

      function annotSegmentDistance(point, a, b) {
        const dx = b.x - a.x;
        const dy = b.y - a.y;
        const lengthSq = dx * dx + dy * dy;
        if (!(lengthSq > 0)) return Math.hypot(point.x - a.x, point.y - a.y);
        const t = Math.max(0, Math.min(1, ((point.x - a.x) * dx + (point.y - a.y) * dy) / lengthSq));
        return Math.hypot(point.x - (a.x + t * dx), point.y - (a.y + t * dy));
      }

      /** Inside-or-on one triangle (the arrow head is a filled triangle, not a line). */
      function annotPointInTriangle(point, triangle) {
        if (!triangle || triangle.length !== 3) return false;
        const cross = (a, b) => (b.x - a.x) * (point.y - a.y) - (b.y - a.y) * (point.x - a.x);
        const d1 = cross(triangle[0], triangle[1]);
        const d2 = cross(triangle[1], triangle[2]);
        const d3 = cross(triangle[2], triangle[0]);
        const hasNegative = d1 < -1e-9 || d2 < -1e-9 || d3 < -1e-9;
        const hasPositive = d1 > 1e-9 || d2 > 1e-9 || d3 > 1e-9;
        return !(hasNegative && hasPositive);
      }

      function annotHitContext() {
        if (annotHitCtxRef.current) return annotHitCtxRef.current;
        try {
          const canvas = document.createElement('canvas');
          canvas.width = 1;
          canvas.height = 1;
          annotHitCtxRef.current = canvas.getContext('2d');
        } catch { annotHitCtxRef.current = null; }
        return annotHitCtxRef.current;
      }

      /**
       * Real Path2D hit for rect/ellipse (§11.4): a hollow shape only hits on its stroke band, a
       * filled one hits its interior too; an ellipse never falls back to its bounding box.
       */
      function annotHitPath(shape, point, radius) {
        const context = annotHitContext();
        if (!context) return false;
        let path = null;
        try {
          path = new Path2D();
          if (shape.type === 'rect') path.rect(shape.x, shape.y, shape.w, shape.h);
          else path.ellipse(shape.cx, shape.cy, shape.rx, shape.ry, 0, 0, Math.PI * 2);
        } catch { return false; }
        if (shape.fill && context.isPointInPath(path, point.x, point.y)) return true;
        if (!shape.stroke) return false;
        context.lineWidth = radius * 2;
        return context.isPointInStroke(path, point.x, point.y);
      }

      /** Text uses the rendered `getBBox()` in canvas CSS px; unreadable bbox = no hit (no guessing). */
      function annotHitText(shape, point, padding = 0) {
        const svg = annotSvgRef.current;
        if (!svg) return false;
        const id = String(shape.id || '').replace(/["\\]/g, '');
        const node = svg.querySelector('g[data-utb-annot-id="' + id + '"] text');
        if (!node || typeof node.getBBox !== 'function') return false;
        let box = null;
        try { box = node.getBBox(); } catch { box = null; }
        if (!box || !(box.width > 0) || !(box.height > 0)) return false;
        return point.x >= box.x - padding && point.x <= box.x + box.width + padding
          && point.y >= box.y - padding && point.y <= box.y + box.height + padding;
      }

      function annotHitArrow(shape, point, radius) {
        const geometry = annotArrowGeometry({ x: shape.x1, y: shape.y1 }, { x: shape.x2, y: shape.y2 }, shape.strokeWidth);
        if (!geometry) return annotSegmentDistance(point, { x: shape.x1, y: shape.y1 }, { x: shape.x2, y: shape.y2 }) <= radius;
        if (annotSegmentDistance(point, { x: shape.x1, y: shape.y1 }, geometry.base) <= radius) return true;
        return annotPointInTriangle(point, geometry.points);
      }

      function annotHitsShape(shape, point, hitRadius) {
        const radius = hitRadius === undefined ? annotEraseRadius(shape) : hitRadius;
        if (shape.type === 'rect' || shape.type === 'circle') return annotHitPath(shape, point, radius);
        if (shape.type === 'text') return annotHitText(shape, point, hitRadius === undefined ? 0 : radius);
        if (shape.type === 'arrow') {
          if (annotHitArrow(shape, point, radius)) return true;
          if (hitRadius === undefined) return false;
          const geometry = annotArrowGeometry({ x: shape.x1, y: shape.y1 }, { x: shape.x2, y: shape.y2 }, shape.strokeWidth);
          return Boolean(geometry && geometry.points.some((a, index, points) =>
            annotSegmentDistance(point, a, points[(index + 1) % points.length]) <= radius));
        }
        if (shape.type === 'line') {
          return annotSegmentDistance(point, { x: shape.x1, y: shape.y1 }, { x: shape.x2, y: shape.y2 }) <= radius;
        }
        if (shape.type === 'brush') {
          const points = shape.points || [];
          if (points.length === 1) return Math.hypot(point.x - points[0].x, point.y - points[0].y) <= radius;
          for (let index = 1; index < points.length; index += 1) {
            if (annotSegmentDistance(point, points[index - 1], points[index]) <= radius) return true;
          }
          return false;
        }
        return false;
      }

      function resetAnnotErase() {
        const erase = annotEraseRef.current;
        const svg = annotSvgRef.current;
        if (erase.active && svg && erase.pointerId >= 0) {
          try { svg.releasePointerCapture(erase.pointerId); } catch { /* ignore */ }
        }
        annotEraseRef.current = { active: false, pointerId: -1, map: null, last: null, changed: 0 };
      }

      /* ---- 选择 / 框选（v3）----------------------------------------------------------------
       * 选中集合只属于本面板：不写 Host 文档、不改变 SVG 图形的数据属性之外的任何事实。
       * 点选用屏幕空间容差命中最上层图形；框选以手势开始时的集合为基准实时预览。
       * 只有「移动」与「删除」会改图形并走既有的 150ms 合并上报；选中本身零上报。
       * ------------------------------------------------------------------------------------ */

      function annotSelectionRefresh() {
        setAnnotVersion((value) => value + 1);
      }

      /** Coalesce pointer-move re-renders to one per animation frame (move stays smooth). */
      function annotSelectionScheduleRender() {
        if (annotSelectionRafRef.current) return;
        annotSelectionRafRef.current = window.requestAnimationFrame(() => {
          annotSelectionRafRef.current = 0;
          annotSelectionRefresh();
        });
      }

      function annotSelectionCount() {
        return annotSelectionRef.current.size;
      }

      /** Click modifiers toggle; marquee modifiers use union/difference/intersection instead. */
      function annotSelectionMode(event) {
        if (event.shiftKey && event.altKey) return 'intersect';
        if (event.altKey) return 'subtract';
        if (event.shiftKey) return 'add';
        if (event.ctrlKey || event.metaKey) return 'toggle';
        return 'replace';
      }

      function annotApplySelection(ids, mode, base, scheduled) {
        const existing = new Set(annotShapesRef.current.map((shape) => shape.id));
        const hits = new Set(ids.filter((id) => existing.has(id)));
        const next = mode === 'replace' ? new Set() : new Set([...base].filter((id) => existing.has(id)));
        if (mode === 'intersect') {
          for (const id of next) if (!hits.has(id)) next.delete(id);
        } else {
          for (const id of hits) {
            if (mode === 'subtract' || (mode === 'toggle' && next.has(id))) next.delete(id);
            else next.add(id);
          }
        }
        const previous = annotSelectionRef.current;
        if (next.size === previous.size && [...next].every((id) => previous.has(id))) return;
        annotSelectionRef.current = next;
        if (scheduled) annotSelectionScheduleRender();
        else annotSelectionRefresh();
      }

      function annotSetSelection(ids, additive) {
        annotApplySelection(ids, additive ? 'toggle' : 'replace', annotSelectionRef.current, false);
      }

      function annotClearSelection() {
        if (!annotSelectionRef.current.size) return;
        annotSelectionRef.current = new Set();
        annotSelectionRefresh();
      }

      /** Drop ids the current document no longer contains (import/erase/clear). */
      function annotPruneSelection() {
        if (!annotSelectionRef.current.size) return;
        const existing = new Set(annotShapesRef.current.map((shape) => shape.id));
        let changed = false;
        for (const id of Array.from(annotSelectionRef.current)) {
          if (!existing.has(id)) { annotSelectionRef.current.delete(id); changed = true; }
        }
        if (changed) annotSelectionRefresh();
      }

      /** Analytic bbox in canvas CSS px (text uses the rendered getBBox, else a conservative estimate). */
      function annotShapeBounds(shape) {
        const move = annotMoveRef.current;
        const base = move.active && move.bounds && move.bounds.get(shape.id);
        if (base) return { x: base.x + move.dx, y: base.y + move.dy, w: base.w, h: base.h };
        const width = Number(shape.strokeWidth);
        const pad = (Number.isFinite(width) && width > 0 ? width : 1) / 2 + 1;
        if (shape.type === 'circle') {
          return { x: shape.cx - shape.rx - pad, y: shape.cy - shape.ry - pad, w: shape.rx * 2 + pad * 2, h: shape.ry * 2 + pad * 2 };
        }
        if (shape.type === 'rect') {
          return { x: shape.x - pad, y: shape.y - pad, w: shape.w + pad * 2, h: shape.h + pad * 2 };
        }
        if (shape.type === 'line' || shape.type === 'arrow') {
          const points = [{ x: shape.x1, y: shape.y1 }, { x: shape.x2, y: shape.y2 }];
          if (shape.type === 'arrow') {
            const geometry = annotArrowGeometry(points[0], points[1], shape.strokeWidth);
            if (geometry) points.push(...geometry.points);
          }
          const x = Math.min(...points.map((point) => point.x)) - pad;
          const y = Math.min(...points.map((point) => point.y)) - pad;
          return { x, y,
            w: Math.max(...points.map((point) => point.x)) - x + pad,
            h: Math.max(...points.map((point) => point.y)) - y + pad };
        }
        if (shape.type === 'brush') {
          const points = shape.points || [];
          if (!points.length) return null;
          let x1 = Infinity; let y1 = Infinity; let x2 = -Infinity; let y2 = -Infinity;
          for (const point of points) {
            x1 = Math.min(x1, point.x); y1 = Math.min(y1, point.y);
            x2 = Math.max(x2, point.x); y2 = Math.max(y2, point.y);
          }
          return { x: x1 - pad, y: y1 - pad, w: x2 - x1 + pad * 2, h: y2 - y1 + pad * 2 };
        }
        if (shape.type === 'text') {
          const svg = annotSvgRef.current;
          if (svg) {
            const id = String(shape.id || '').replace(/["\\]/g, '');
            const node = svg.querySelector('g[data-utb-annot-id="' + id + '"] text');
            if (node && typeof node.getBBox === 'function') {
              try {
                const box = node.getBBox();
                if (box.width > 0 && box.height > 0) return {
                  // During React render the DOM may still contain the previous position.
                  x: box.x + shape.x - Number(node.getAttribute('x')),
                  y: box.y + shape.y - Number(node.getAttribute('y')),
                  w: box.width, h: box.height,
                };
              } catch { /* fall through to the estimate */ }
            }
          }
          // Conservative estimate (CJK ≈ 1em, ASCII ≈ 0.5em) so a box selection still catches the text.
          const text = String(shape.text || '');
          let estimated = 0;
          for (const char of text) estimated += /[\u2e80-\u9fff\uf900-\ufaff\uff00-\uffef]/u.test(char) ? 20 : 10;
          return { x: shape.x, y: shape.y, w: Math.max(estimated, 20), h: 20 };
        }
        return null;
      }

      function annotRectIntersects(a, b) {
        return a.x < b.x + b.w && a.x + a.w > b.x && a.y < b.y + b.h && a.y + a.h > b.y;
      }

      /** Keep thin strokes easy to select at every zoom; eraser tolerance stays unchanged. */
      function annotTopmostAt(point, map) {
        const shapes = annotShapesRef.current;
        const scale = map ? Math.max(0.01, Math.min(map.sx, map.sy)) : 1;
        for (let index = shapes.length - 1; index >= 0; index -= 1) {
          const shape = shapes[index];
          const radius = Math.max(Number(shape.strokeWidth || 1) / 2, 6 / scale);
          if (annotHitsShape(shape, point, radius)) return shape;
        }
        return null;
      }

      /** Union bounding box of the selected shapes (null when nothing is selected). */
      function annotSelectionBounds() {
        if (!annotSelectionRef.current.size) return null;
        let x1 = Infinity; let y1 = Infinity; let x2 = -Infinity; let y2 = -Infinity;
        for (const shape of annotShapesRef.current) {
          if (!annotSelectionRef.current.has(shape.id)) continue;
          const box = annotShapeBounds(shape);
          if (!box) continue;
          x1 = Math.min(x1, box.x); y1 = Math.min(y1, box.y);
          x2 = Math.max(x2, box.x + box.w); y2 = Math.max(y2, box.y + box.h);
        }
        if (!(x2 >= x1) || !(y2 >= y1)) return null;
        return { x: x1, y: y1, w: x2 - x1, h: y2 - y1 };
      }

      /**
       * Inside the selection's union box. This is what makes selected shapes draggable from their
       * interior (a hollow rect's stroke-only hit test would miss) and lets a marquee-selected
       * group be dragged from the gap between its members.
       */
      function annotSelectionContains(point) {
        const box = annotSelectionBounds();
        return Boolean(box && point.x >= box.x && point.x <= box.x + box.w
          && point.y >= box.y && point.y <= box.y + box.h);
      }

      /** Translate one shape by a canvas-space delta (all six geometries; no style change). */
      function annotTranslateShape(shape, dx, dy) {
        if (!dx && !dy) return shape;
        if (shape.type === 'circle') return Object.assign({}, shape, { cx: shape.cx + dx, cy: shape.cy + dy });
        if (shape.type === 'rect') return Object.assign({}, shape, { x: shape.x + dx, y: shape.y + dy });
        if (shape.type === 'line' || shape.type === 'arrow') {
          return Object.assign({}, shape, {
            x1: shape.x1 + dx, y1: shape.y1 + dy, x2: shape.x2 + dx, y2: shape.y2 + dy,
          });
        }
        if (shape.type === 'brush') {
          return Object.assign({}, shape, { points: (shape.points || []).map((point) => ({ x: point.x + dx, y: point.y + dy })) });
        }
        if (shape.type === 'text') return Object.assign({}, shape, { x: shape.x + dx, y: shape.y + dy });
        return shape;
      }

      function annotSelectionOrigin() {
        const ids = annotSelectionRef.current;
        return annotShapesRef.current
          .filter((shape) => ids.has(shape.id))
          .map((shape) => ({ id: shape.id, shape }));
      }

      function annotStartMove(map, event, point) {
        const origin = annotSelectionOrigin();
        if (!origin.length) return false;
        annotMarqueeRef.current = { active: false, pointerId: -1, map: null, start: null, end: null, node: null };
        annotMoveRef.current = {
          active: true, pointerId: event.pointerId, map, start: point, last: point, origin,
          originals: new Map(origin.map((item) => [item.id, item.shape])),
          bounds: new Map(origin.map((item) => [item.id, annotShapeBounds(item.shape)])),
          dragging: false, axis: null, dx: 0, dy: 0, changed: false,
        };
        annotMapSigRef.current = annotMapSignature(map);
        const svg = annotSvgRef.current;
        try { if (svg) svg.setPointerCapture(event.pointerId); } catch { /* ignore */ }
        setAnnotBusy(true);
        return true;
      }

      function moveAnnotSelection(event) {
        const move = annotMoveRef.current;
        if (!move.active) return;
        const point = annotToCanvasRaw(move.map, event.clientX, event.clientY);
        move.last = point;
        let dx = point.x - move.start.x;
        let dy = point.y - move.start.y;
        const screen = Math.hypot(dx * move.map.sx, dy * move.map.sy);
        // Latch once: after a real drag, returning to the press point must restore the original.
        if (!move.dragging && screen < 4) return;
        move.dragging = true;
        if (event.shiftKey) {
          if (!move.axis) move.axis = Math.abs(dx * move.map.sx) >= Math.abs(dy * move.map.sy) ? 'x' : 'y';
          if (move.axis === 'x') dy = 0;
          else dx = 0;
        } else move.axis = null;
        if (dx === move.dx && dy === move.dy) return;
        move.dx = dx;
        move.dy = dy;
        move.changed = Boolean(dx || dy);
        annotShapesRef.current = annotShapesRef.current.map((shape) => {
          const base = move.originals.get(shape.id);
          return base ? annotTranslateShape(base, dx, dy) : shape;
        });
        annotSetHoverCursor('grabbing');
        annotSelectionScheduleRender();
      }

      function finishAnnotMove() {
        const move = annotMoveRef.current;
        if (!move.active) return;
        const svg = annotSvgRef.current;
        try { if (svg) svg.releasePointerCapture(move.pointerId); } catch { /* ignore */ }
        const changed = move.changed;
        annotMoveRef.current = { active: false, pointerId: -1, map: null, start: null, last: null, origin: null, changed: false };
        if (move.acceptedShapes) {
          annotApplyImported(move.acceptedShapes);
          if (changed) annotShapesRef.current = annotShapesRef.current.map((shape) => move.originals.has(shape.id)
            ? annotTranslateShape(shape, move.dx, move.dy) : shape);
        }
        setAnnotBusy(false);
        if (changed) {
          annotContentSeqRef.current += 1;
          annotDirtyRef.current = true;
          annotPublishSchedule();
        }
        if (!move.dragging && move.toggleOnClick) annotSetSelection([move.toggleOnClick], true);
        annotSetHoverCursor('move');
        annotSelectionRefresh();
        annotResumeAfterTransient();
      }

      /** Roll back a move gesture to the shapes captured at pointerdown; no publish happens. */
      function cancelAnnotMove() {
        const move = annotMoveRef.current;
        if (!move.active) return;
        const origin = new Map((move.origin || []).map((item) => [item.id, item.shape]));
        annotShapesRef.current = annotShapesRef.current.map((shape) => origin.get(shape.id) || shape);
        const svg = annotSvgRef.current;
        try { if (svg) svg.releasePointerCapture(move.pointerId); } catch { /* ignore */ }
        annotMoveRef.current = { active: false, pointerId: -1, map: null, start: null, last: null, origin: null, changed: false };
        if (move.acceptedShapes) annotApplyImported(move.acceptedShapes);
        if (annotSelectionRafRef.current) {
          window.cancelAnimationFrame(annotSelectionRafRef.current);
          annotSelectionRafRef.current = 0;
        }
        setAnnotBusy(false);
        annotSelectionRefresh();
        annotResumeAfterTransient();
      }

      function annotMarqueeRect(marquee) {
        const start = marquee.start || { x: 0, y: 0 };
        const end = marquee.end || start;
        return {
          x: Math.min(start.x, end.x), y: Math.min(start.y, end.y),
          w: Math.abs(end.x - start.x), h: Math.abs(end.y - start.y),
        };
      }

      /** The marquee preview lives in the imperative draft group (no React render per move). */
      function annotMarqueeNode() {
        const marquee = annotMarqueeRef.current;
        if (marquee.node && marquee.node.isConnected) return marquee.node;
        const draft = annotDraftRef.current;
        if (!draft) return null;
        const node = annotDraftNode('rect', { x: 0, y: 0, width: 0, height: 0, fill: 'none' });
        node.setAttribute('class', 'utb-annot-marquee-box');
        node.setAttribute('data-utb-annot-marquee', 'true');
        draft.appendChild(node);
        marquee.node = node;
        return node;
      }

      function renderAnnotMarquee() {
        const marquee = annotMarqueeRef.current;
        if (!marquee.active) return;
        const node = annotMarqueeNode();
        if (!node) return;
        const rect = annotMarqueeRect(marquee);
        node.setAttribute('x', String(rect.x));
        node.setAttribute('y', String(rect.y));
        node.setAttribute('width', String(rect.w));
        node.setAttribute('height', String(rect.h));
      }

      function startAnnotMarquee(map, event, point) {
        cancelAnnotMove();
        resetAnnotMarquee();
        cancelAnnotDraft();
        annotMarqueeRef.current = {
          active: true, pointerId: event.pointerId, map, start: point, end: point,
          mode: annotSelectionMode(event), base: new Set(annotSelectionRef.current), dragging: false,
          // Cache bounds once; text getBBox and stroke geometry need not run on every pointermove.
          boxes: annotShapesRef.current.map((shape) => ({ id: shape.id, box: annotShapeBounds(shape) })),
          node: null,
        };
        annotMapSigRef.current = annotMapSignature(map);
        const svg = annotSvgRef.current;
        try { if (svg) svg.setPointerCapture(event.pointerId); } catch { /* ignore */ }
        setAnnotBusy(true);
      }

      function moveAnnotMarquee(event) {
        const marquee = annotMarqueeRef.current;
        if (!marquee.active) return;
        marquee.end = annotToCanvasRaw(marquee.map, event.clientX, event.clientY);
        const rect = annotMarqueeRect(marquee);
        if (!marquee.dragging && Math.hypot(rect.w * marquee.map.sx, rect.h * marquee.map.sy) < 4) return;
        marquee.dragging = true;
        marquee.mode = annotSelectionMode(event);
        renderAnnotMarquee();
        const ids = marquee.boxes.filter((item) => item.box && annotRectIntersects(item.box, rect)).map((item) => item.id);
        annotApplySelection(ids, marquee.mode, marquee.base, true);
        if (marquee.node) marquee.node.setAttribute('data-utb-annot-marquee-mode', marquee.mode);
        annotSetHoverCursor('crosshair');
      }

      function resetAnnotMarquee() {
        const marquee = annotMarqueeRef.current;
        const svg = annotSvgRef.current;
        if (marquee.active && svg && marquee.pointerId >= 0) {
          try { svg.releasePointerCapture(marquee.pointerId); } catch { /* ignore */ }
        }
        if (marquee.node && marquee.node.parentNode) marquee.node.parentNode.removeChild(marquee.node);
        annotMarqueeRef.current = { active: false, pointerId: -1, map: null, start: null, end: null, node: null };
      }

      function finishAnnotMarquee() {
        const marquee = annotMarqueeRef.current;
        if (!marquee.active) return;
        // Preview is already the final set. A modified empty click preserves the base selection.
        if (!marquee.dragging) annotApplySelection([], marquee.mode === 'replace' ? 'replace' : 'add', marquee.base, false);
        resetAnnotMarquee();
        clearAnnotDraftNode();
        setAnnotBusy(false);
        annotSelectionRefresh();
        annotResumeAfterTransient();
      }

      function cancelAnnotMarquee() {
        const marquee = annotMarqueeRef.current;
        if (!marquee.active) return;
        annotSelectionRef.current = new Set(marquee.base);
        resetAnnotMarquee();
        clearAnnotDraftNode();
        setAnnotBusy(false);
        annotSelectionRefresh();
        annotResumeAfterTransient();
      }

      /** Delete every selected shape (one document change, one coalesced publish). */
      function annotDeleteSelection() {
        if (!annotRef.current.on) return false;
        cancelAnnotMove();
        cancelAnnotMarquee();
        if (!annotSelectionRef.current.size) return false;
        const ids = annotSelectionRef.current;
        const before = annotShapesRef.current.length;
        annotShapesRef.current = annotShapesRef.current.filter((shape) => !ids.has(shape.id));
        annotSelectionRef.current = new Set();
        const removed = before - annotShapesRef.current.length;
        if (removed > 0) {
          annotContentSeqRef.current += 1;
          annotDirtyRef.current = true;
          annotPublishSchedule();
        }
        annotSelectionRefresh();
        return removed > 0;
      }

      /** One sample point deletes the topmost hit only (no distance re-ranking, no drill-through). */
      function annotEraseAt(point) {
        const shapes = annotShapesRef.current;
        for (let index = shapes.length - 1; index >= 0; index -= 1) {
          if (annotHitsShape(shapes[index], point)) {
            annotShapesRef.current = shapes.slice(0, index).concat(shapes.slice(index + 1));
            annotEraseRef.current.changed += 1;
            annotPruneSelection();
            annotContentSeqRef.current += 1;
            annotDirtyRef.current = true;
            setAnnotVersion((value) => value + 1);
            return true;
          }
        }
        return false;
      }

      /** Unclamped canvas point through a frozen mapping (the eraser must not smear on the border). */
      function annotToCanvasRaw(map, clientX, clientY) {
        return {
          x: map.cx + (clientX - map.painted.left) / map.sx,
          y: map.cy + (clientY - map.painted.top) / map.sy,
        };
      }

      /** Only samples inside the visible canvas rect are erased (docs/viewport-control.md). */
      function annotInViewRect(map, point) {
        return point.x >= map.cx && point.x <= map.cx + map.w && point.y >= map.cy && point.y <= map.cy + map.h;
      }

      function startAnnotErase(map, event, point) {
        const svg = annotSvgRef.current;
        resetAnnotErase();
        annotEraseRef.current = { active: true, pointerId: event.pointerId, map, last: point, changed: 0 };
        annotMapSigRef.current = annotMapSignature(map);
        try { if (svg) svg.setPointerCapture(event.pointerId); } catch { /* ignore */ }
        // 按下即擦；无命中时不排任何上报（§12.3：无命中的橡皮擦零 POST）。
        if (annotEraseAt(point)) annotPublishSchedule();
      }

      function moveAnnotErase(event) {
        const erase = annotEraseRef.current;
        // 沿冻结映射取未 clamp 的画布点：拖出 P 时只处理与可见矩形相交的采样，不沿边界额外擦。
        const point = annotToCanvasRaw(erase.map, event.clientX, event.clientY);
        const last = erase.last || point;
        const dx = point.x - last.x;
        const dy = point.y - last.y;
        // 原地去重：同一坐标重复 move 不再采样（不会继续钻层）。
        if (Math.abs(dx) < 1e-6 && Math.abs(dy) < 1e-6) return;
        const steps = Math.max(1, Math.ceil(Math.hypot(dx, dy) / ANNOT_ERASE_STEP_PX));
        let erased = false;
        for (let index = 1; index <= steps; index += 1) {
          const sample = { x: last.x + (dx * index) / steps, y: last.y + (dy * index) / steps };
          if (!annotInViewRect(erase.map, sample)) continue;
          if (annotEraseAt(sample)) erased = true;
        }
        erase.last = point;
        if (erased) annotPublishSchedule();
      }

      function finishAnnotErase() {
        const erase = annotEraseRef.current;
        if (!erase.active) return;
        const changed = erase.changed;
        resetAnnotErase();
        if (changed) annotFlushPending(); // 结束 flush；擦掉的对象不因 cancel/Esc 回滚
      }

      /** 清除画布：清已完成 + 草稿/编辑，立即发布空文档，保留模式/工具/样式（§11.4）。 */
      /**
       * 标注栏「截图」：把**当前页面 + 已接受的标注**合成一张 PNG，作为附件放进聊天框。
       *
       * 语义边界（docs/viewport-control.md）：走 Host 的 `POST /screenshot {includeAnnotations:true}`，
       * 也就是 Agent 的 `browser_screenshot{includeAnnotations:true}` 同一条离屏合成路径，因此像素与
       * 证据完全一致，不是面板自己另画一遍 SVG。它沿用面板的 scope 身份；附件通过 Conversation 服务
       * 注册成 draft attachment（`createDrafts` + `addAttachments`），照片字节随消息发送，不落盘。
       */
      function annotShotTarget() {
        const sid = baseIdentity && baseIdentity.kind === 'session' ? String(baseIdentity.sessionId || '') : '';
        if (!sid) return { ok: false, reason: '当前面板没有绑定会话，无法加入聊天框附件' };
        const ctx = pluginContext;
        if (!ctx || typeof ctx.get !== 'function') return { ok: false, reason: '聊天框服务不可用' };
        let sessions = null;
        let conversation = null;
        try {
          sessions = ctx.get('sessions');
          conversation = ctx.get('conversation');
        } catch {
          return { ok: false, reason: '聊天框服务不可用' };
        }
        if (!conversation || typeof conversation.createDrafts !== 'function'
          || !conversation.input || typeof conversation.input.for !== 'function'
          || !sessions || typeof sessions.binding !== 'function') {
          return { ok: false, reason: '聊天框服务不可用' };
        }
        let binding = null;
        try { binding = sessions.binding(sid); } catch { binding = null; }
        if (!binding || !binding.ctx) return { ok: false, reason: '会话尚未就绪（未 retain），稍后再试' };
        let face = null;
        try { face = conversation.input.for(binding.ctx); } catch { face = null; }
        if (!face || typeof face.addAttachments !== 'function') return { ok: false, reason: '聊天框服务不可用' };
        return { ok: true, sid, conversation, face };
      }

      async function captureAnnotationShot() {
        if (annotShotBusy) return;
        setAnnotShotNotice('');
        const target = annotShotTarget();
        if (!target.ok) {
          setAnnotShotNotice('截图失败：' + target.reason);
          return;
        }
        setAnnotShotBusy(true);
        try {
          // 先让「已接受」的文档追上最新笔画：截图取的是 Host 侧文档，pending 时不等待就会少一笔。
          if (annotDirtyRef.current || annotSyncRef.current.state === 'pending') {
            try { annotFlushPending(); } catch { /* best effort */ }
            await new Promise((resolve) => { window.setTimeout(resolve, 260); });
          }
          const scopeNow = scopeRef.current;
          const response = await fetch(HOST_BASE + '/screenshot', {
            method: 'POST',
            headers: Object.assign({ 'content-type': 'application/json' }, scopeHeaders(scopeNow)),
            credentials: 'same-origin',
            body: JSON.stringify({ includeAnnotations: true }),
          });
          const payload = await response.json().catch(() => null);
          if (!response.ok || !payload || payload.ok !== true || !payload.image) {
            throw new Error((payload && (payload.error || payload.reason)) || ('HTTP ' + response.status));
          }
          const binary = atob(payload.image);
          const bytes = new Uint8Array(binary.length);
          for (let index = 0; index < binary.length; index += 1) bytes[index] = binary.charCodeAt(index);
          const stamp = new Date().toISOString().replace(/[:.]/g, '-');
          const file = new File([bytes], 'annotation-' + stamp + '.png', { type: 'image/png' });
          const drafts = target.conversation.createDrafts(target.sid, [file], false);
          const list = Array.isArray(drafts) ? drafts : [];
          const ids = list.map((draft) => draft && draft.id).filter(Boolean);
          if (!ids.length) throw new Error('附件没有被聊天框接受');
          const added = target.face.addAttachments(ids);
          if (!added) {
            // 回车发送中/命令执行中的聊天框会拒绝新附件：立刻释放，避免留下看不见的孤儿附件。
            for (const draft of list) {
              try { target.conversation.releaseDraftAttachment(draft.id); } catch { /* best effort */ }
            }
            throw new Error('聊天框正忙（发送中），稍后再试');
          }
          // 成功不弹任何提示：附件本身就出现在聊天框里，那一张缩略图就是结果；
          // 失败才在按钮旁给具体原因（静默失败才是真问题）。
          try { if (typeof target.face.focus === 'function') target.face.focus(); } catch { /* best effort */ }
        } catch (error) {
          setAnnotShotNotice('截图失败：' + String((error && error.message) || error));
        } finally {
          setAnnotShotBusy(false);
        }
      }

      function clearAnnotCanvas() {
        if (!annotRef.current.on) return;
        // The pointerdown of the button already cancelled a live edit; this covers keyboard activation.
        if (annotEditRef.current.active) cancelAnnotText();
        cancelAnnotDraft();
        resetAnnotErase();
        resetAnnotMarquee();
        annotMoveRef.current = { active: false, pointerId: -1, map: null, start: null, last: null, origin: null, changed: false };
        annotSelectionRef.current = new Set();
        annotShapesRef.current = [];
        annotContentSeqRef.current += 1;
        annotDirtyRef.current = true;
        setAnnotText(null);
        setAnnotVersion((value) => value + 1);
        // Explicit user clear is a content modification (release:false empty document), not a release.
        annotPublishNow();
      }

      /** 清除按钮的按下阶段：先取消编辑，压住随后的 blur 提交（防止文字“复活”）。 */
      function annotClearPointerDown() {
        cancelAnnotDraft();
        if (annotEditRef.current.active) cancelAnnotText();
      }

      function annotDraftNode(tag, attrs) {
        const node = document.createElementNS(SVG_NS, tag);
        for (const [key, value] of Object.entries(attrs || {})) node.setAttribute(key, String(value));
        node.setAttribute('pointer-events', 'none');
        return node;
      }

      /** Arrow geometry: head length min(3t, L), base width min(2t, L), same-colour filled triangle. */
      function annotArrowGeometry(start, end, width) {
        const dx = end.x - start.x;
        const dy = end.y - start.y;
        const length = Math.hypot(dx, dy);
        if (!(length > 0)) return null;
        const t = Math.max(1, Number(width) || 1);
        const headLength = Math.min(3 * t, length);
        const headWidth = Math.min(2 * t, length);
        const ux = dx / length;
        const uy = dy / length;
        const base = { x: end.x - ux * headLength, y: end.y - uy * headLength };
        const nx = -uy;
        const ny = ux;
        return {
          length,
          base,
          points: [
            end,
            { x: base.x + nx * (headWidth / 2), y: base.y + ny * (headWidth / 2) },
            { x: base.x - nx * (headWidth / 2), y: base.y - ny * (headWidth / 2) },
          ],
        };
      }

      function annotPointsText(points) {
        return (points || []).map((point) => `${Math.round(point.x * 100) / 100},${Math.round(point.y * 100) / 100}`).join(' ');
      }

      function clearAnnotDraftNode() {
        const draft = annotDraftRef.current;
        if (!draft) return;
        while (draft.firstChild) draft.removeChild(draft.firstChild);
      }

      function buildAnnotDraft(gesture) {
        const draft = annotDraftRef.current;
        if (!draft) return;
        clearAnnotDraftNode();
        const style = gesture.style;
        const fill = style.fill ? style.color : 'none';
        const stroke = style.stroke ? style.color : 'none';
        gesture.nodes = {};
        if (gesture.tool === 'circle') {
          gesture.nodes.circle = annotDraftNode('ellipse', {
            cx: gesture.start.x, cy: gesture.start.y, rx: 0, ry: 0,
            fill, stroke, 'stroke-width': style.width, 'stroke-linecap': 'round', 'stroke-linejoin': 'round',
          });
          draft.appendChild(gesture.nodes.circle);
        } else if (gesture.tool === 'rect') {
          gesture.nodes.rect = annotDraftNode('rect', {
            x: gesture.start.x, y: gesture.start.y, width: 0, height: 0,
            fill, stroke, 'stroke-width': style.width, 'stroke-linecap': 'round', 'stroke-linejoin': 'round',
          });
          draft.appendChild(gesture.nodes.rect);
        } else if (gesture.tool === 'line') {
          gesture.nodes.line = annotDraftNode('line', {
            x1: gesture.start.x, y1: gesture.start.y, x2: gesture.start.x, y2: gesture.start.y,
            fill: 'none', stroke: style.color, 'stroke-width': style.width, 'stroke-linecap': 'round',
          });
          draft.appendChild(gesture.nodes.line);
        } else if (gesture.tool === 'arrow') {
          gesture.nodes.line = annotDraftNode('line', {
            x1: gesture.start.x, y1: gesture.start.y, x2: gesture.start.x, y2: gesture.start.y,
            fill: 'none', stroke: style.color, 'stroke-width': style.width, 'stroke-linecap': 'round',
          });
          gesture.nodes.polygon = annotDraftNode('polygon', {
            points: annotPointsText([gesture.start, gesture.start, gesture.start]),
            fill: style.color, stroke: 'none',
          });
          draft.appendChild(gesture.nodes.line);
          draft.appendChild(gesture.nodes.polygon);
        } else if (gesture.tool === 'brush') {
          gesture.nodes.polyline = annotDraftNode('polyline', {
            points: annotPointsText(gesture.points),
            fill: 'none', stroke: style.color, 'stroke-width': style.width,
            'stroke-linecap': 'round', 'stroke-linejoin': 'round',
          });
          draft.appendChild(gesture.nodes.polyline);
        }
      }

      function renderAnnotDraft(gesture) {
        if (!gesture || !gesture.nodes) return;
        const start = gesture.start;
        const end = gesture.end || start;
        if (gesture.tool === 'circle' && gesture.nodes.circle) {
          // PS ellipse default: the press and the release are two bbox corners (any direction).
          gesture.nodes.circle.setAttribute('cx', String((start.x + end.x) / 2));
          gesture.nodes.circle.setAttribute('cy', String((start.y + end.y) / 2));
          gesture.nodes.circle.setAttribute('rx', String(Math.abs(end.x - start.x) / 2));
          gesture.nodes.circle.setAttribute('ry', String(Math.abs(end.y - start.y) / 2));
        } else if (gesture.tool === 'rect' && gesture.nodes.rect) {
          gesture.nodes.rect.setAttribute('x', String(Math.min(start.x, end.x)));
          gesture.nodes.rect.setAttribute('y', String(Math.min(start.y, end.y)));
          gesture.nodes.rect.setAttribute('width', String(Math.abs(end.x - start.x)));
          gesture.nodes.rect.setAttribute('height', String(Math.abs(end.y - start.y)));
        } else if (gesture.tool === 'line' && gesture.nodes.line) {
          gesture.nodes.line.setAttribute('x1', String(start.x));
          gesture.nodes.line.setAttribute('y1', String(start.y));
          gesture.nodes.line.setAttribute('x2', String(end.x));
          gesture.nodes.line.setAttribute('y2', String(end.y));
        } else if (gesture.tool === 'arrow' && gesture.nodes.line && gesture.nodes.polygon) {
          const geometry = annotArrowGeometry(start, end, gesture.style.width);
          if (geometry) {
            gesture.nodes.line.setAttribute('x1', String(start.x));
            gesture.nodes.line.setAttribute('y1', String(start.y));
            gesture.nodes.line.setAttribute('x2', String(geometry.base.x));
            gesture.nodes.line.setAttribute('y2', String(geometry.base.y));
            gesture.nodes.polygon.setAttribute('points', annotPointsText(geometry.points));
          }
        } else if (gesture.tool === 'brush' && gesture.nodes.polyline) {
          const points = gesture.points.concat([end]);
          gesture.nodes.polyline.setAttribute('points', annotPointsText(points));
        }
      }

      function scheduleAnnotRender(gesture) {
        if (annotRafRef.current) return;
        annotRafRef.current = window.requestAnimationFrame(() => {
          annotRafRef.current = 0;
          const current = annotGestureRef.current;
          if (current.active && current === gesture) renderAnnotDraft(current);
        });
      }

      function resetAnnotGesture() {
        annotGestureRef.current = {
          active: false, pointerId: -1, map: null, tool: '', style: null,
          start: null, end: null, points: [], trace: [], pathLen: 0,
          lastScreen: null, lastSampleScreen: null, lastPoint: null, nodes: null,
        };
      }

      function cancelAnnotDraft() {
        if (annotRafRef.current) {
          window.cancelAnimationFrame(annotRafRef.current);
          annotRafRef.current = 0;
        }
        const gesture = annotGestureRef.current;
        const svg = annotSvgRef.current;
        if (gesture.active && svg && gesture.pointerId >= 0) {
          try { svg.releasePointerCapture(gesture.pointerId); } catch { /* ignore */ }
        }
        resetAnnotGesture();
        clearAnnotDraftNode();
        setAnnotBusy(false);
        // A cancelled gesture may leave the panel clean: a newer Host revision can be adopted now.
        annotResumeAfterTransient();
      }

      /** Allocate a local id above both the local watermark and every imported `aN` (never reuse). */
      function annotAllocateId() {
        const used = new Set(annotShapesRef.current.map((item) => item.id));
        if (!Number.isSafeInteger(annotNextIdRef.current) || annotNextIdRef.current < 0) {
          annotNextIdRef.current = 0;
        }
        let id = '';
        let guard = 0;
        do {
          annotNextIdRef.current += 1;
          id = 'a' + annotNextIdRef.current;
          guard += 1;
          if (guard > 100000) break;
        } while (used.has(id));
        return id;
      }

      function pushAnnotShape(shape) {
        annotShapesRef.current = annotShapesRef.current.concat([
          Object.assign({ id: annotAllocateId() }, shape),
        ]);
        annotContentSeqRef.current += 1;
        annotDirtyRef.current = true;
        setAnnotVersion((value) => value + 1);
        // 提交/文字提交进入 150ms trailing 合并（§11.3）；失败只影响同步状态，不影响绘制。
        annotPublishSchedule();
      }

      /** Validate the committed gesture; null = below the minimum gesture (nothing is created). */
      function annotCommitFromGesture(gesture, point) {
        const start = gesture.start;
        const map = gesture.map;
        const style = gesture.style;
        const dxScreen = (point.x - start.x) * map.sx;
        const dyScreen = (point.y - start.y) * map.sy;
        if (gesture.tool === 'circle') {
          // Bbox minimum: both sides ≥2 screen px (a thin drag is not an object).
          if (Math.abs(dxScreen) < 2 || Math.abs(dyScreen) < 2) return null;
          return {
            type: 'circle',
            cx: (start.x + point.x) / 2,
            cy: (start.y + point.y) / 2,
            rx: Math.abs(point.x - start.x) / 2,
            ry: Math.abs(point.y - start.y) / 2,
            color: style.color, strokeWidth: style.width, fill: Boolean(style.fill), stroke: Boolean(style.stroke),
          };
        }
        if (gesture.tool === 'rect') {
          if (Math.abs(dxScreen) < 2 || Math.abs(dyScreen) < 2) return null;
          return {
            type: 'rect', x: Math.min(start.x, point.x), y: Math.min(start.y, point.y),
            w: Math.abs(point.x - start.x), h: Math.abs(point.y - start.y),
            color: style.color, strokeWidth: style.width, fill: Boolean(style.fill), stroke: Boolean(style.stroke),
          };
        }
        if (gesture.tool === 'line' || gesture.tool === 'arrow') {
          if (Math.hypot(dxScreen, dyScreen) < 2) return null;
          return { type: gesture.tool, x1: start.x, y1: start.y, x2: point.x, y2: point.y, color: style.color, strokeWidth: style.width, fill: false, stroke: true };
        }
        if (gesture.tool === 'brush') {
          // A tiny closed loop can accumulate ≥2 screen px without ever reaching the 2 px sampling
          // threshold between samples; fall back to the raw trace in that case only.
          let points = gesture.points.slice();
          if (points.length < 2 && gesture.trace.length >= 2) points = gesture.trace.slice();
          const last = points[points.length - 1];
          if (!last || Math.abs(last.x - point.x) > 1e-6 || Math.abs(last.y - point.y) > 1e-6) points.push(point);
          // Cumulative *screen* path length (a closed loop returning to the first point is valid).
          if (gesture.pathLen < 2 || points.length < 2) return null;
          return { type: 'brush', points, color: style.color, strokeWidth: style.width, fill: false, stroke: true };
        }
        return null;
      }

      function onAnnotPointerDown(event) {
        if (!annotRef.current.on || event.button !== 0) return;
        const map = annotMap();
        if (!map || !annotInside(map, event.clientX, event.clientY)) return; // letterbox: no stroke
        event.preventDefault();
        event.stopPropagation();
        const svg = annotSvgRef.current;
        if (svg) { try { svg.focus({ preventScroll: true }); } catch { /* ignore */ } }
        const point = annotToCanvas(map, event.clientX, event.clientY);
        if (annotRef.current.tool === 'text') {
          openAnnotText(map, point);
          return;
        }
        if (annotRef.current.tool === 'eraser') {
          // 橡皮擦不产生图形、不走最小画图手势：按下即擦、拖动连续擦（§11.4）。
          cancelAnnotDraft();
          startAnnotErase(map, event, point);
          return;
        }
        if (annotRef.current.tool === 'select') {
          cancelAnnotDraft();
          const hit = annotTopmostAt(point, map);
          const mode = annotSelectionMode(event);
          if (!hit) {
            if (mode === 'replace' && annotSelectionContains(point)) annotStartMove(map, event, point);
            else startAnnotMarquee(map, event, point); // empty-space drag works with either tool
            return;
          }
          if (mode === 'subtract' || mode === 'intersect') {
            annotApplySelection([hit.id], mode, annotSelectionRef.current, false);
            return;
          }
          if (mode !== 'replace' && annotSelectionRef.current.has(hit.id)) {
            // Shift-click toggles on release, but Shift-drag keeps the group and locks its axis.
            annotStartMove(map, event, point);
            annotMoveRef.current.toggleOnClick = hit.id;
            return;
          }
          if (!annotSelectionRef.current.has(hit.id)) annotApplySelection([hit.id], mode, annotSelectionRef.current, false);
          annotStartMove(map, event, point);
          return;
        }
        if (annotRef.current.tool === 'marquee') {
          if (annotSelectionMode(event) === 'replace' && annotSelectionContains(point)) {
            cancelAnnotDraft();
            annotStartMove(map, event, point);
            return;
          }
          startAnnotMarquee(map, event, point);
          return;
        }
        cancelAnnotDraft();
        setAnnotBusy(true);
        const style = annotSnapshot();
        const gesture = {
          active: true, pointerId: event.pointerId, map, tool: style.tool, style,
          start: point, end: point, points: [point], trace: [point], pathLen: 0,
          lastScreen: { x: event.clientX, y: event.clientY },
          lastSampleScreen: { x: event.clientX, y: event.clientY },
          lastPoint: point, nodes: null,
        };
        annotGestureRef.current = gesture;
        annotMapSigRef.current = annotMapSignature(map);
        buildAnnotDraft(gesture);
        renderAnnotDraft(gesture);
        try { if (svg) svg.setPointerCapture(event.pointerId); } catch { /* ignore */ }
      }

      function annotSetHoverCursor(mode) {
        const next = ['move', 'grabbing', 'crosshair'].includes(mode) ? mode : 'default';
        annotHoverRef.current = next;
        const svg = annotSvgRef.current;
        if (svg) svg.style.cursor = next;
      }

      /** Select/marquee hover: 'move' over a shape or inside the selection box, else the tool base. */
      function annotUpdateHoverCursor(event) {
        const base = annotRef.current.tool === 'marquee' ? 'crosshair' : 'default';
        const map = annotMap();
        if (!map || !annotInside(map, event.clientX, event.clientY)) {
          annotSetHoverCursor(base);
          return;
        }
        const point = annotToCanvas(map, event.clientX, event.clientY);
        const modified = annotSelectionMode(event) !== 'replace';
        const movable = annotRef.current.tool === 'select'
          ? !event.altKey && (annotTopmostAt(point, map) || (!modified && annotSelectionContains(point)))
          : !modified && annotSelectionContains(point);
        annotSetHoverCursor(movable ? 'move' : base);
      }

      function onAnnotPointerMove(event) {
        if (annotRef.current.on && annotEraseRef.current.active
          && annotEraseRef.current.pointerId === event.pointerId) {
          event.preventDefault();
          moveAnnotErase(event);
          return;
        }
        if (annotMoveRef.current.active && annotMoveRef.current.pointerId === event.pointerId) {
          if (!annotRef.current.on) return;
          event.preventDefault();
          moveAnnotSelection(event);
          return;
        }
        if (annotMarqueeRef.current.active && annotMarqueeRef.current.pointerId === event.pointerId) {
          if (!annotRef.current.on) return;
          event.preventDefault();
          moveAnnotMarquee(event);
          return;
        }
        if (annotRef.current.on && (annotRef.current.tool === 'select' || annotRef.current.tool === 'marquee')
          && !annotGestureRef.current.active) {
          annotUpdateHoverCursor(event);
          return;
        }
        const gesture = annotGestureRef.current;
        if (!annotRef.current.on || !gesture.active || gesture.pointerId !== event.pointerId) return;
        event.preventDefault();
        const point = annotToCanvas(gesture.map, event.clientX, event.clientY);
        if (gesture.tool === 'brush') {
          const step = Math.hypot(event.clientX - gesture.lastScreen.x, event.clientY - gesture.lastScreen.y);
          gesture.pathLen += step;
          gesture.lastScreen = { x: event.clientX, y: event.clientY };
          gesture.trace.push(point);
          const sinceSample = Math.hypot(event.clientX - gesture.lastSampleScreen.x, event.clientY - gesture.lastSampleScreen.y);
          // ≥2 screen CSS px between sampled points; the final point is appended on pointerup.
          if (sinceSample >= 2) {
            gesture.points.push(point);
            gesture.lastSampleScreen = { x: event.clientX, y: event.clientY };
            gesture.lastPoint = point;
          }
        }
        gesture.end = point;
        scheduleAnnotRender(gesture);
      }

      function onAnnotPointerUp(event) {
        if (annotEraseRef.current.active && annotEraseRef.current.pointerId === event.pointerId) {
          event.preventDefault();
          finishAnnotErase();
          return;
        }
        if (annotMoveRef.current.active && annotMoveRef.current.pointerId === event.pointerId) {
          event.preventDefault();
          moveAnnotSelection(event);
          finishAnnotMove();
          return;
        }
        if (annotMarqueeRef.current.active && annotMarqueeRef.current.pointerId === event.pointerId) {
          event.preventDefault();
          moveAnnotMarquee(event);
          finishAnnotMarquee();
          return;
        }
        const gesture = annotGestureRef.current;
        if (!annotRef.current.on || !gesture.active || gesture.pointerId !== event.pointerId) return;
        event.preventDefault();
        const point = annotToCanvas(gesture.map, event.clientX, event.clientY);
        const shape = annotCommitFromGesture(gesture, point);
        const svg = annotSvgRef.current;
        try { if (svg) svg.releasePointerCapture(event.pointerId); } catch { /* ignore */ }
        if (annotRafRef.current) {
          window.cancelAnimationFrame(annotRafRef.current);
          annotRafRef.current = 0;
        }
        resetAnnotGesture();
        clearAnnotDraftNode();
        setAnnotBusy(false);
        if (shape) pushAnnotShape(shape);
      }

      function onAnnotPointerCancel(event) {
        if (annotEraseRef.current.active
          && (event === undefined || event.pointerId === undefined || annotEraseRef.current.pointerId === event.pointerId)) {
          // 擦掉的对象不因 pointercancel/Esc 回滚，结束时照常 flush（§11.4）。
          finishAnnotErase();
          return;
        }
        if (annotMoveRef.current.active
          && (event === undefined || event.pointerId === undefined || annotMoveRef.current.pointerId === event.pointerId)) {
          cancelAnnotMove();
          return;
        }
        if (annotMarqueeRef.current.active
          && (event === undefined || event.pointerId === undefined || annotMarqueeRef.current.pointerId === event.pointerId)) {
          cancelAnnotMarquee();
          return;
        }
        const gesture = annotGestureRef.current;
        if (!gesture.active) return;
        if (event && event.pointerId !== undefined && gesture.pointerId !== event.pointerId) return;
        cancelAnnotDraft();
      }

      function openAnnotText(map, point) {
        cancelAnnotDraft();
        if (annotEditRef.current.active) commitAnnotText();
        const style = annotSnapshot();
        const screen = annotScreenPoint(map, point);
        annotEditRef.current = {
          active: true, cancel: false, map, x: point.x, y: point.y, style,
        };
        annotMapSigRef.current = annotMapSignature(map);
        annotEditSeqRef.current += 1;
        setAnnotText({
          id: annotEditSeqRef.current,
          left: screen.x - map.boxRect.left,
          top: screen.y - map.boxRect.top,
          fontSize: 20 * map.sy,
          color: style.color,
        });
        window.requestAnimationFrame(() => {
          const input = annotInputRef.current;
          if (input) { try { input.focus(); } catch { /* ignore */ } }
        });
      }

      /** Commit/cancel one text edit. Cancellation is marked *before* the input unmounts, so the
       * subsequent blur cannot submit twice (docs/viewport-control.md). */
      function finishAnnotText(commit) {
        const edit = annotEditRef.current;
        if (!edit.active) return;
        const input = annotInputRef.current;
        const value = input ? String(input.value || '') : '';
        edit.active = false;
        if (!commit) edit.cancel = true;
        setAnnotText(null);
        if (!commit || edit.cancel) {
          if (!commit) annotResumeAfterTransient();
          return;
        }
        const text = value.slice(0, 200);
        if (!text.trim()) return;
        pushAnnotShape({
          type: 'text', x: edit.x, y: edit.y, text,
          color: edit.style.color, strokeWidth: edit.style.width, fill: true, stroke: false,
        });
      }

      function commitAnnotText() {
        finishAnnotText(true);
      }

      function cancelAnnotText() {
        const edit = annotEditRef.current;
        if (edit.active) edit.cancel = true;
        finishAnnotText(false);
      }

      /** Cancel the uncommitted draft/edit only; committed shapes stay (mode exit keeps them). */
      function annotCancelTransient() {
        cancelAnnotDraft();
        cancelAnnotMove();
        cancelAnnotMarquee();
        resetAnnotErase();
        setAnnotBusy(false);
        const edit = annotEditRef.current;
        if (edit.active) {
          edit.cancel = true;
          edit.active = false;
          setAnnotText(null);
        }
        // A cancelled gesture/edit may make the panel clean again: adopt a pending Host revision
        // and/or retry a remembered dirty document once the channel is available (§12.3).
        annotResumeAfterTransient();
      }

      function enterAnnotMode() {
        // 用户 2026-11-03 第 2 条：尺寸调整模式内禁止进入标注（程序化/键盘同一道闸）。
        if (sizingRef.current) return;
        // 选元素模式与标注互斥：同一道闸，程序化/键盘入口也不得越过。
        if (pickRef.current.on) return;
        if (annotRef.current.on || !viewSync || !canvasOn) return;
        // Finish any page drag (release its button) *before* the mode gate is raised.
        if (dragRef.current.active) releaseFrameDrag();
        // Drop unsent pan/zoom intent: entering the mode must not publish a stale view.
        const panWrite = panWriteRef.current;
        if (panWrite.timer) {
          window.clearTimeout(panWrite.timer);
          panWrite.timer = 0;
        }
        panWrite.latest = null;
        cancelPanDrag();
        panModeRef.current = false;
        setPanMode(false);
        setPanDragging(false);
        clearZoomIntent();
        resetZoomAnchor();
        setMenu(false);
        cancelDraft();
        annotRef.current.on = true;
        setAnnotOn(true);
        window.requestAnimationFrame(() => {
          const svg = annotSvgRef.current;
          if (svg) { try { svg.focus({ preventScroll: true }); } catch { /* ignore */ } }
        });
      }

      function exitAnnotMode() {
        if (!annotRef.current.on) return;
        // Closing the panel exits the mode but keeps every committed annotation visible (contract §5).
        annotCancelTransient();
        annotSelectionRef.current = new Set();
        setAnnotText(null);
        resetAnnotErase();
        setAnnotBusy(false);
        annotRef.current.on = false;
        setAnnotOn(false);
        // v2：模式退出立即 flush（§11.3）。
        annotFlushPending();
      }

      function toggleAnnotMode() {
        if (annotRef.current.on) exitAnnotMode();
        else enterAnnotMode();
      }

      /* ---- 选元素发送到聊天框：模式 / 悬浮命中 / 加入聊天框 ------------------------------- */

      /** 入口可用条件（与按钮 disabled 同源）：运行中 + 就绪 + 视口 + 画布 + 标注/尺寸互斥。 */
      function pickAvailable() {
        const current = remoteRef.current;
        return Boolean(current && current.running === true && readyRef.current
          && viewRef.current && canvasRef.current
          && !annotRef.current.on && !sizingRef.current);
      }

      function pickSetStatus(text, kind) {
        setPickStatus({ text: String(text || ''), kind: kind || 'info' });
        window.clearTimeout(pickStatusTimerRef.current);
        pickStatusTimerRef.current = window.setTimeout(() => setPickStatus(null), PICK_STATUS_MS);
      }

      /** 只清悬浮框（保留模式）：递增序号让在途的过期响应失效。 */
      function pickClearOverlay() {
        const ref = pickRef.current;
        ref.hoverSeq += 1;
        ref.hoverQueued = false;
        if (ref.timer) {
          window.clearTimeout(ref.timer);
          ref.timer = 0;
        }
        // 一个待触发的滚动去抖不该在清框后把旧指针位置的框重新画回来。
        if (ref.wheelTimer) {
          window.clearTimeout(ref.wheelTimer);
          ref.wheelTimer = 0;
        }
        setPickOverlay(null);
      }

      function exitPickMode() {
        const ref = pickRef.current;
        if (!ref.on) return;
        ref.on = false;
        // 让所有在途响应（悬浮/详情）按序号与模式双重条件丢弃。
        ref.hoverSeq += 1;
        ref.detailSeq += 1;
        ref.hoverQueued = false;
        ref.hoverInflight = false;
        ref.detailInflight = false;
        if (ref.timer) {
          window.clearTimeout(ref.timer);
          ref.timer = 0;
        }
        if (ref.wheelTimer) {
          window.clearTimeout(ref.wheelTimer);
          ref.wheelTimer = 0;
        }
        // 页面输入无需显式恢复：派发路径按 pickRef.current.on 实时判定。
        setPickOn(false);
        setPickOverlay(null);
      }

      function enterPickMode() {
        const ref = pickRef.current;
        if (ref.on) return;
        // 与标注/尺寸调整互斥：任一在开时直接 no-op（程序化/键盘同一道闸）。
        if (annotRef.current.on || sizingRef.current) return;
        if (!pickAvailable()) return;
        // Raise the gate only after the active page drag released its button.
        if (dragRef.current.active) releaseFrameDrag();
        const panWrite = panWriteRef.current;
        if (panWrite.timer) {
          window.clearTimeout(panWrite.timer);
          panWrite.timer = 0;
        }
        panWrite.latest = null;
        cancelPanDrag();
        panModeRef.current = false;
        setPanMode(false);
        setPanDragging(false);
        clearZoomIntent();
        resetZoomAnchor();
        setMenu(false);
        ref.on = true;
        ref.lastClient = null;
        ref.hoverQueued = false;
        setPickStatus(null);
        setPickOverlay(null);
        setPickOn(true);
      }

      function togglePickMode() {
        if (pickRef.current.on) exitPickMode();
        else enterPickMode();
      }

      /** 悬浮命中节流（≥80ms 间隔）并合并到最新指针位置；单飞，在途时只记一个待办。 */
      function pickScheduleHover(clientX, clientY) {
        const ref = pickRef.current;
        if (!ref.on) return;
        if (Number.isFinite(Number(clientX)) && Number.isFinite(Number(clientY))) {
          ref.lastClient = { x: Number(clientX), y: Number(clientY) };
        }
        if (!ref.lastClient || ref.detailInflight) return;
        if (ref.hoverInflight || ref.timer) {
          ref.hoverQueued = true;
          return;
        }
        const wait = PICK_HOVER_MS - (Date.now() - ref.lastAt);
        if (wait <= 0) {
          pickRequestHover();
          return;
        }
        ref.timer = window.setTimeout(() => {
          ref.timer = 0;
          pickRequestHover();
        }, wait);
      }

      function pickRequestHover() {
        const ref = pickRef.current;
        if (!ref.on || ref.hoverInflight || ref.detailInflight || !ref.lastClient) return;
        const geom = frameGeometry();
        if (!geom) return;
        const point = mapEventPoint({ clientX: ref.lastClient.x, clientY: ref.lastClient.y }, geom);
        if (!point.inside || point.blank) {
          pickClearOverlay();
          return;
        }
        const canvas = canvasPosition();
        if (!canvas) return;
        const requestC = { x: Number(canvas.x), y: Number(canvas.y) };
        const epoch = scopeEpochRef.current;
        const seq = ref.hoverSeq + 1;
        ref.hoverSeq = seq;
        ref.hoverInflight = true;
        ref.hoverQueued = false;
        ref.lastAt = Date.now();
        callHost('element', { x: point.q.x + canvas.x, y: point.q.y + canvas.y, detail: false }, {
          scope: scopeRef.current,
          signal: abortRef.current ? abortRef.current.signal : undefined,
        }).then((payload) => {
          if (scopeEpochRef.current !== epoch || !ref.on || ref.hoverSeq !== seq) return;
          // C 是框坐标的基准：响应回来时画布原点已移动（滚动/平移/Agent 改视口）→ 丢弃这次框，
          // 按最后一次指针位置重取，绝不画出错位的框。
          const current = canvasPosition();
          if (!current
            || Math.abs(Number(current.x) - requestC.x) > 0.5
            || Math.abs(Number(current.y) - requestC.y) > 0.5) {
            ref.hoverSeq += 1;
            setPickOverlay(null);
            if (ref.on) pickScheduleHover();
            return;
          }
          setPickOverlay(pickOverlayOf(payload && payload.element));
        }).catch(() => {
          if (scopeEpochRef.current !== epoch || !ref.on || ref.hoverSeq !== seq) return;
          setPickOverlay(null);
        }).finally(() => {
          ref.hoverInflight = false;
          if (ref.on && ref.hoverQueued) pickScheduleHover();
        });
      }

      /** 滚轮仍滚动目标页；滚动稳定（180ms 去抖）后按最后指针位置重取悬浮命中。 */
      function pickAfterWheel(clientX, clientY) {
        const ref = pickRef.current;
        if (!ref.on) return;
        ref.lastClient = { x: clientX, y: clientY };
        if (ref.wheelTimer) window.clearTimeout(ref.wheelTimer);
        ref.wheelTimer = window.setTimeout(() => {
          ref.wheelTimer = 0;
          if (ref.on) pickScheduleHover();
        }, PICK_WHEEL_DEBOUNCE_MS);
      }

      /**
       * 把文本块追加到 DSH 聊天框末尾。child tab 的 identity 不是聊天对象，始终用 baseIdentity。
       *
       * 公开路径是 `conversation.input.requestDraftInitialization(binding, {whenDraftExists:'append'})`：
       * 空草稿 setDraft(text)，非空走编辑器 appendDraft（新段落追加、保留 @引用 chip/quote）。
       * 注意 `shell.appendDraft` 不是公开面（SessionInputShell 上没有），因此绝不用 setDraft 拼接
       * 作为降级——那会丢掉 chip/quote；接口缺失/未 retain 一律明确 unavailable。
       * 返回 {ok} 或 {ok:false, reason: no-session|unavailable|busy|error}。
       */
      function pickAppendToChat(text) {
        const sid = baseIdentity && baseIdentity.kind === 'session' ? String(baseIdentity.sessionId || '') : '';
        if (!sid) return { ok: false, reason: 'no-session' };
        const ctx = pluginContext;
        if (!ctx || typeof ctx.get !== 'function') return { ok: false, reason: 'unavailable' };
        let sessions = null;
        let input = null;
        try {
          sessions = ctx.get('sessions');
          const conversation = ctx.get('conversation');
          input = conversation && conversation.input;
        } catch {
          return { ok: false, reason: 'unavailable' };
        }
        if (!input || typeof input.requestDraftInitialization !== 'function') return { ok: false, reason: 'unavailable' };
        if (!sessions || typeof sessions.binding !== 'function') return { ok: false, reason: 'unavailable' };
        // 只有已 retain 的 Session 才有 binding；未 retain 不 materialize（那是会话控制器的职责）。
        let binding = null;
        try {
          binding = sessions.binding(sid);
        } catch {
          binding = null;
        }
        if (!binding) return { ok: false, reason: 'not-retained' };
        let result = null;
        try {
          result = input.requestDraftInitialization(binding, { prompt: text, whenDraftExists: 'append' });
        } catch {
          // 同步 throw = binding 代次已失效（会话切换/retain 被释放）。
          return { ok: false, reason: 'stale-binding' };
        }
        // blocked = disposed 或 phase ∈ {adjudicating, submitting, sending}；preserved 不该出现（append）。
        if (result === 'blocked') return { ok: false, reason: 'busy' };
        if (result !== 'applied') return { ok: false, reason: 'unavailable' };
        // 焦点 best-effort：把键盘还给该会话的 composer（拿不到就静默忽略）。
        try {
          const face = typeof input.for === 'function' ? input.for(binding.ctx) : null;
          if (face && typeof face.focus === 'function') face.focus();
        } catch { /* focus 是 best-effort */ }
        return { ok: true };
      }

      /** pointerdown：用当下坐标重新 detail:true 命中（绝不复用可能过期的悬浮结果）。 */
      function pickCommitAt(event) {
        const ref = pickRef.current;
        if (!ref.on || ref.detailInflight) return;
        const geom = frameGeometry();
        if (!geom) return;
        const point = mapEventPoint(event, geom);
        if (!point.inside) return;
        if (point.blank) {
          showBlankHint();
          return;
        }
        const canvas = canvasPosition();
        if (!canvas) return;
        const epoch = scopeEpochRef.current;
        const seq = ref.detailSeq + 1;
        ref.detailSeq = seq;
        ref.detailInflight = true;
        callHost('element', { x: point.q.x + canvas.x, y: point.q.y + canvas.y, detail: true }, {
          scope: scopeRef.current,
          signal: abortRef.current ? abortRef.current.signal : undefined,
        }).then((payload) => {
          if (scopeEpochRef.current !== epoch || !ref.on || ref.detailSeq !== seq) return;
          const element = payload && payload.element;
          if (!element) {
            pickSetStatus('未命中页面元素（页面可能已变化）', 'error');
            return;
          }
          const sessionId = baseIdentity && baseIdentity.kind === 'session' ? String(baseIdentity.sessionId || '') : '';
          const elementPayload = pickElementPayload(element, activeUrl);
          const locator = pickCollapseText(element.selector) || pickCompoundSelector(element);
          const chip = pickInsertElementChip(sessionId, elementPayload);
          if (chip.ok) {
            elementRefRemember(sessionId, elementPayload);
            pickSetStatus('已加入聊天框（引用）：' + locator, 'ok');
            exitPickMode();
            return;
          }
          // 降级：chip 不可插入（服务缺失/未 retain/忙）时仍把完整块追加为纯文本，并如实标注。
          const appended = pickAppendToChat(pickElementModelText(elementPayload));
          if (!appended.ok) {
            pickSetStatus(pickChatFailureText(appended.reason), 'error');
            return;
          }
          elementRefRemember(sessionId, elementPayload);
          pickSetStatus('已加入聊天框（文本）：' + locator + (chip.reason ? '（引用不可用：' + chip.reason + '）' : ''), 'ok');
          exitPickMode();
        }).catch((error) => {
          if (scopeEpochRef.current !== epoch || !ref.on || ref.detailSeq !== seq) return;
          if (error && error.name === 'AbortError') return;
          pickSetStatus(pickElementFailureText(error), 'error');
        }).finally(() => {
          if (ref.detailSeq !== seq) return;
          ref.detailInflight = false;
          if (ref.on && ref.hoverQueued) pickScheduleHover();
        });
      }

      function chooseAnnotTool(tool) {
        if (!annotRef.current.on || tool === annotRef.current.tool) return;
        cancelAnnotDraft();
        cancelAnnotMove();
        cancelAnnotMarquee();
        annotSetHoverCursor(tool === 'marquee' ? 'crosshair' : 'default');
        if (annotEditRef.current.active) commitAnnotText();
        // 切回绘制/橡皮擦/文字时清空选择；选择 ↔ 框选之间保留，方便先点选再框选追加。
        if (!annotIsSelectionTool(tool)) annotClearSelection();
        annotRef.current.tool = tool;
        const style = annotStyleFor(tool, annotRef.current.mode || 'stroke');
        annotRef.current.fill = style.fill;
        annotRef.current.stroke = style.stroke;
        setAnnotTool(tool);
      }

      function changeAnnotStyle(patch) {
        if (!annotRef.current.on) return;
        cancelAnnotDraft();
        if (annotEditRef.current.active) commitAnnotText();
        Object.assign(annotRef.current, patch);
        if (patch.color !== undefined) setAnnotColor(patch.color);
        if (patch.width !== undefined) setAnnotWidth(patch.width);
      }

      /**
       * 用户 2026-11-03 第 1 条：填充/外框分页选择器。恰好一个选中；点已选项完全 no-op
       * （在 cancel/commit 等副作用之前返回）。只有圆形/矩形可切换，其它工具整组 disabled。
       */
      function changeAnnotStyleMode(next) {
        const current = annotRef.current;
        if (!current.on || !annotIsClosedTool(current.tool) || next === current.mode) return;
        cancelAnnotDraft();
        if (annotEditRef.current.active) commitAnnotText();
        current.mode = next;
        const style = annotStyleFor(current.tool, next);
        current.fill = style.fill;
        current.stroke = style.stroke;
        setAnnotStyleMode(next);
      }

      function annotTextKey(event) {
        // IME composition owns Enter/Escape; keyCode 229 is the composition placeholder.
        if (event.keyCode === 229 || annotComposingRef.current || (event.nativeEvent && event.nativeEvent.isComposing)) return;
        if (event.key === 'Enter') {
          event.preventDefault();
          commitAnnotText();
          return;
        }
        if (event.key === 'Escape') {
          event.preventDefault();
          cancelAnnotText();
        }
      }

      /** Committed shape → React SVG node. Geometry data lives on the root g; native geometry on
       * the child element, so data, SVG and screen position can all be checked independently.
       * `extra` is used by the selection halo (same geometry, accent styling, no committed state). */
      function renderAnnotShape(shape, extra) {
        const common = Object.assign({
          key: shape.id,
          'data-utb-annot-id': shape.id,
          'data-utb-annot-type': shape.type,
          'data-utb-annot-state': 'committed',
          'data-utb-annot-color': shape.color,
          'data-utb-annot-stroke-width': String(shape.strokeWidth),
          'data-utb-annot-fill': shape.fill ? 'true' : 'false',
          'data-utb-annot-stroke': shape.stroke ? 'true' : 'false',
          style: { pointerEvents: 'none' },
        }, extra || {});
        if (shape.type === 'circle') {
          return h('g', Object.assign({}, common, {
            'data-utb-annot-cx': String(shape.cx),
            'data-utb-annot-cy': String(shape.cy),
            'data-utb-annot-rx': String(shape.rx),
            'data-utb-annot-ry': String(shape.ry),
          }), h('ellipse', {
            cx: shape.cx, cy: shape.cy, rx: shape.rx, ry: shape.ry,
            fill: shape.fill ? shape.color : 'none',
            stroke: shape.stroke ? shape.color : 'none',
            strokeWidth: shape.stroke ? shape.strokeWidth : 0,
          }));
        }
        if (shape.type === 'rect') {
          return h('g', Object.assign({}, common, {
            'data-utb-annot-x': String(shape.x),
            'data-utb-annot-y': String(shape.y),
            'data-utb-annot-width': String(shape.w),
            'data-utb-annot-height': String(shape.h),
          }), h('rect', {
            x: shape.x, y: shape.y, width: shape.w, height: shape.h,
            fill: shape.fill ? shape.color : 'none',
            stroke: shape.stroke ? shape.color : 'none',
            strokeWidth: shape.stroke ? shape.strokeWidth : 0,
          }));
        }
        if (shape.type === 'line') {
          return h('g', Object.assign({}, common, {
            'data-utb-annot-x1': String(shape.x1),
            'data-utb-annot-y1': String(shape.y1),
            'data-utb-annot-x2': String(shape.x2),
            'data-utb-annot-y2': String(shape.y2),
          }), h('line', {
            x1: shape.x1, y1: shape.y1, x2: shape.x2, y2: shape.y2,
            fill: 'none', stroke: shape.color, strokeWidth: shape.strokeWidth, strokeLinecap: 'round',
          }));
        }
        if (shape.type === 'arrow') {
          const geometry = annotArrowGeometry({ x: shape.x1, y: shape.y1 }, { x: shape.x2, y: shape.y2 }, shape.strokeWidth);
          const base = geometry ? geometry.base : { x: shape.x2, y: shape.y2 };
          return h('g', Object.assign({}, common, {
            'data-utb-annot-x1': String(shape.x1),
            'data-utb-annot-y1': String(shape.y1),
            'data-utb-annot-x2': String(shape.x2),
            'data-utb-annot-y2': String(shape.y2),
            'data-utb-annot-head-length': geometry ? String(Math.min(3 * shape.strokeWidth, geometry.length)) : '0',
            'data-utb-annot-head-width': geometry ? String(Math.min(2 * shape.strokeWidth, geometry.length)) : '0',
          }), [
            h('line', {
              key: 'shaft', x1: shape.x1, y1: shape.y1, x2: base.x, y2: base.y,
              fill: 'none', stroke: shape.color, strokeWidth: shape.strokeWidth, strokeLinecap: 'round',
            }),
            h('polygon', {
              key: 'head',
              points: geometry ? annotPointsText(geometry.points) : '',
              fill: shape.color, stroke: 'none',
            }),
          ]);
        }
        if (shape.type === 'brush') {
          return h('g', Object.assign({}, common, {
            'data-utb-annot-points': JSON.stringify(shape.points),
          }), h('polyline', {
            points: annotPointsText(shape.points),
            fill: 'none', stroke: shape.color, strokeWidth: shape.strokeWidth,
            strokeLinecap: 'round', strokeLinejoin: 'round',
          }));
        }
        if (shape.type === 'text') {
          return h('g', Object.assign({}, common, {
            'data-utb-annot-x': String(shape.x),
            'data-utb-annot-y': String(shape.y),
            'data-utb-annot-font-size': '20',
          }), h('text', {
            x: shape.x, y: shape.y, fontSize: 20,
            fill: shape.color, stroke: 'none',
            fontFamily: 'system-ui, -apple-system, "Segoe UI", sans-serif',
            fontWeight: 400,
            dominantBaseline: 'text-before-edge',
          }, shape.text));
        }
        return null;
      }

      /**
       * A wheel notch is a fire-and-forget adjustment, not a draft: once the request settled (in
       * either direction) the field must follow the Host again. A typed draft keeps its flag until
       * the user commits or cancels it.
       */
      function clearSettledWheelDrafts(submitted) {
        for (const field of Object.keys(submitted)) {
          const wheelVersion = viewWheelRef.current[field];
          if (wheelVersion && viewEditRef.current[field] === wheelVersion) {
            viewDirtyRef.current[field] = null;
          }
        }
      }

      function logViewReject(code) {
        console.warn('ui-testing: viewport patch rejected (' + code + ')');
      }

      function noteViewEdit(field, draftValue) {
        viewEditRef.current[field] += 1;
        viewWheelRef.current[field] = 0;
        viewDirtyRef.current[field] = Number.isFinite(Number(draftValue)) && String(draftValue).trim() !== ''
          ? Number(draftValue)
          : NaN;
      }

      /** Numeric value of one field as the Host last accepted it (null when unknown). */
      function hostFieldValue(field) {
        const view = viewRef.current;
        if (!view) return null;
        if (field === 'scale') return Number(view.scale) * 100;
        if (field === 'width') return Number(view.width);
        if (field === 'height') return Number(view.height);
        const canvas = canvasPosition();
        if (field === 'x') return canvas ? canvas.x : observedScroll().x;
        if (field === 'y') return canvas ? canvas.y : observedScroll().y;
        return null;
      }

      /** Legal draft → number, otherwise null (nothing is sent for an illegal intermediate state). */
      function fieldLegal(field, text) {
        const raw = String(text === undefined || text === null ? '' : text).trim();
        if (!raw) return null;
        const number = Number(raw);
        if (!Number.isFinite(number)) return null;
        if (field === 'width' || field === 'height') {
          const range = VIEW_LIMITS[field];
          if (!Number.isInteger(number) || number < range[0] || number > range[1]) return null;
          return number;
        }
        if (field === 'x' || field === 'y') {
          // Canvas coordinates are signed; the legacy fallback keeps the non-negative scroll range.
          const range = canvasActive() ? VIEW_LIMITS.canvas : VIEW_LIMITS.scroll;
          if (number < range[0] || number > range[1]) return null;
          return Math.round(number * 100) / 100;
        }
        if (field === 'scale') {
          const range = VIEW_LIMITS.scalePercent;
          if (number < range[0] || number > range[1]) return null;
          return Math.round(number);
        }
        return null;
      }

      function patchForField(field, numeric) {
        if (field === 'scale') return { scale: Math.round(numeric) / 100 };
        const patch = {};
        patch[field] = numeric;
        return patch;
      }

      function pushField(field, numeric) {
        // An old Host (no shared view) has no scale/x/y field: its ratio stays a local preference,
        // so only width/height are ever written through the legacy `{width,height}` body.
        if (!viewRef.current && field !== 'width' && field !== 'height') return;
        // A size-bar scale edit supersedes a pan-wheel zoom accumulator.
        if (field === 'scale') { clearZoomIntent(); resetZoomAnchor(); }
        if (field === 'width' || field === 'height') pendingGeomRef.current = { since: Date.now() };
        queueViewPatch(patchForField(field, numeric));
      }

      function changeSizeField(field, value) {
        if (field === 'width') setWidth(value); else setHeight(value);
        const numeric = fieldLegal(field, value);
        noteViewEdit(field, numeric === null ? value : numeric);
        if (numeric !== null) pushField(field, numeric);
      }

      function changePositionField(field, value) {
        if (field === 'x') setPosX(value); else setPosY(value);
        const numeric = fieldLegal(field, value);
        noteViewEdit(field, numeric === null ? value : numeric);
      }

      function changeScaleField(value) {
        fitRef.current = false;
        setFit(false);
        setZoom(value);
        const numeric = fieldLegal('scale', value);
        noteViewEdit('scale', numeric === null ? value : numeric);
        if (numeric !== null) pushField('scale', numeric);
      }

      /** Enter/blur: commit a legal draft; an illegal draft reverts to the accepted Host fact. */
      function commitViewField(field) {
        if (field === 'scale' && fitRef.current) {
          // The input currently displays the *local* fit percentage: there is no manual draft to
          // commit, so focusing and leaving it must not cancel fit or publish a ratio.
          viewDirtyRef.current.scale = null;
          viewFocusRef.current = '';
          return;
        }
        const text = field === 'x' ? posX
          : field === 'y' ? posY
            : field === 'width' ? width
              : field === 'height' ? height
                : zoom;
        const numeric = fieldLegal(field, text);
        if (numeric === null) {
          cancelViewField(field);
          return;
        }
        const hostValue = hostFieldValue(field);
        const base = hostValue === null ? numeric : hostValue;
        const unchanged = Math.abs(numeric - base) < 0.0001;
        if (field === 'scale') {
          fitRef.current = false;
          setFit(false);
        }
        viewDirtyRef.current[field] = null;
        viewFocusRef.current = '';
        if (!unchanged) pushField(field, numeric);
        syncViewDrafts();
      }

      function cancelViewField(field) {
        viewDirtyRef.current[field] = null;
        viewFocusRef.current = '';
        syncViewDrafts();
      }

      function sizeFieldKey(event, field) {
        if (event.key === 'Enter') {
          event.preventDefault();
          commitViewField(field);
          return;
        }
        if (event.key === 'Escape') {
          event.preventDefault();
          cancelViewField(field);
        }
      }

      /** One size-bar wheel notch: bounded step, clamp, then the same debounced patch path. */
      function stepViewField(field, direction, event) {
        const steps = WHEEL_STEPS[field];
        if (!steps) return;
        if ((field === 'x' || field === 'y') && !viewRef.current) return;
        const alt = Boolean(event && event.altKey);
        const shift = Boolean(event && event.shiftKey) && !alt;
        const step = alt ? steps.alt : shift ? steps.shift : steps.normal;
        let base;
        if (field === 'scale' && fitRef.current) {
          base = Math.round(fitScaleValue() * 100);
        } else {
          const text = field === 'x' ? posX
            : field === 'y' ? posY
              : field === 'width' ? width
                : field === 'height' ? height
                  : zoom;
          const legal = fieldLegal(field, text);
          if (legal !== null) base = legal;
          else {
            const hostValue = hostFieldValue(field);
            base = hostValue === null ? Number(text) || 0 : hostValue;
          }
        }
        const range = field === 'scale' ? VIEW_LIMITS.scalePercent
          : field === 'width' ? VIEW_LIMITS.width
            : field === 'height' ? VIEW_LIMITS.height
              : (canvasActive() ? VIEW_LIMITS.canvas : VIEW_LIMITS.scroll);
        const next = clampNumber(base + direction * step, range[0], range[1]);
        const rounded = field === 'scale' ? Math.round(next) : Math.round(next * 100) / 100;
        if (field === 'x') setPosX(String(rounded));
        else if (field === 'y') setPosY(String(rounded));
        else if (field === 'width') setWidth(String(rounded));
        else if (field === 'height') setHeight(String(rounded));
        else {
          fitRef.current = false;
          setFit(false);
          setZoom(String(rounded));
        }
        noteViewEdit(field, rounded);
        viewWheelRef.current[field] = viewEditRef.current[field];
        pushField(field, rounded);
      }

      function onSizeWheel(event) {
        if (annotRef.current.on) {
          event.preventDefault();
          event.stopPropagation();
          return;
        }
        const node = event.target && event.target.closest ? event.target.closest('[data-utb-field]') : null;
        if (!node) return;
        const field = node.getAttribute('data-utb-field');
        if (!WHEEL_STEPS[field]) return;
        if (event.ctrlKey || event.metaKey) {
          // Ctrl/Meta+wheel never edits a size field. It is still consumed here: letting the
          // browser default run would step a focused `input[type=number]` natively (a second,
          // unsynchronised write path). Browser zoom stays available everywhere else in the panel.
          event.preventDefault();
          event.stopPropagation();
          return;
        }
        event.preventDefault();
        event.stopPropagation();
        if (!event.deltaY) return;
        markHuman();
        stepViewField(field, event.deltaY < 0 ? 1 : -1, event);
      }

      /** 用户 2026-11-03 第 5 条：粗细输入滚轮（非 passive，clamp 1–20，即时提交，不 markHuman）。 */
      function onAnnotWidthWheel(event) {
        if (!annotRef.current.on) return;
        const node = event.target && event.target.closest ? event.target.closest('[data-utb-annot-field="width"]') : null;
        if (!node) return; // let the narrow bar scroll normally elsewhere
        event.preventDefault();
        event.stopPropagation();
        if (event.ctrlKey || event.metaKey) return;
        if (!event.deltaY) return;
        const current = annotRef.current;
        if (current.tool === 'text' || current.tool === 'eraser') return;
        const alt = Boolean(event.altKey);
        const shift = Boolean(event.shiftKey) && !alt;
        const step = alt ? 1 : shift ? 5 : 1;
        const base = Number(current.width);
        const next = clampNumber(Math.round(base + (event.deltaY < 0 ? step : -step)), 1, 20);
        if (next === base) return;
        changeAnnotStyle({ width: next });
      }

      /**
       * Current painted rect of the displayed frame (contract §5.1); null disables input.
       * The measurement uses the *box* (never the transformed <img>): under canvas compositing the
       * image is translated inside the clipping box, and pointer mapping stays in viewport space.
       */
      function frameGeometry() {
        const img = frameImgRef.current;
        const box = frameBoxRef.current;
        if (!img || !box) return null;
        return paintedRect(box.getBoundingClientRect(), img.naturalWidth, img.naturalHeight);
      }

      /** Is the displayed frame provably the accepted viewport? */
      function geometryMatches(size) {
        const frame = frameGeomRef.current;
        if (!frame || !(frame.naturalW > 0) || !(frame.naturalH > 0)) return false;
        const pageWidth = Number(frame.pageWidth);
        const pageHeight = Number(frame.pageHeight);
        if (Number.isFinite(pageWidth) && pageWidth > 0 && Number.isFinite(pageHeight) && pageHeight > 0) {
          return Math.abs(pageWidth - size.w) <= 1 && Math.abs(pageHeight - size.h) <= 1;
        }
        return Math.abs(frame.naturalW / frame.naturalH - size.w / size.h) <= 0.02;
      }

      /**
       * Pause pointer/wheel input after a width/height change while the displayed frame cannot be
       * proven to match the accepted viewport. Best-effort and bounded (≤250ms); the frame protocol
       * is not extended, so this is a barrier, not a guarantee.
       */
      function inputGeomReady() {
        const pending = pendingGeomRef.current;
        if (!pending) return true;
        if (!geometryMatches(acceptedViewSize())) {
          if (Date.now() - pending.since >= GEOMETRY_WAIT_MS) {
            pendingGeomRef.current = null;
            return true;
          }
          return false;
        }
        pendingGeomRef.current = null;
        return true;
      }

      /** Event → target page CSS point in the accepted viewport (half-open painted rect). */
      function frameInputReady() {
        return readyRef.current && !writesPausedRef.current && inputGeomReady() && canvasBarrier().ready;
      }

      /** 拖拽偏移（宿主 CSS px）→ 画布原点 C：内容跟手（右/下拖 → C 减小，可进入负值）。 */
      function panViewPoint(event, pan) {
        const geom = pan.geom;
        if (!geom || !(geom.width > 0) || !(geom.height > 0)) return { x: pan.startX, y: pan.startY };
        const dx = event.clientX - pan.startClientX;
        const dy = event.clientY - pan.startClientY;
        return {
          x: clampNumber(pan.startX - (dx / geom.width) * pan.viewW, VIEW_LIMITS.canvas[0], VIEW_LIMITS.canvas[1]),
          y: clampNumber(pan.startY - (dy / geom.height) * pan.viewH, VIEW_LIMITS.canvas[0], VIEW_LIMITS.canvas[1]),
        };
      }

      /** One-shot, low-disturbance canvas-blank hint; never a modal or a Runtime error. */
      function showBlankHint() {
        setBlankHint('此处是画布空白，请在页面区域操作');
        window.clearTimeout(blankHintTimerRef.current);
        blankHintTimerRef.current = window.setTimeout(() => setBlankHint(''), 2400);
      }

      /**
       * A blank band can be the .utb-box itself when the live frame is translated away by O. That
       * surface has no page target, so it only gets the one-shot hint (never a dispatch).
       */
      function onBoxPointerDown(event) {
        if (annotRef.current.on || panMode) return;
        if (event.button !== 0) return;
        if (event.target && event.target.closest && event.target.closest('.utb-frame')) return;
        // 选元素模式：点画布空白 = 清悬浮框（零页面派发，也不弹空白提示抢注意力）。
        if (pickRef.current.on) {
          pickClearOverlay();
          return;
        }
        const geom = frameGeometry();
        if (!geom) return;
        const point = mapEventPoint(event, geom);
        if (point.blank) showBlankHint();
      }

      function onFramePointerDown(event) {
        if (annotRef.current.on) return; // annotation mode: zero page input
        // 选元素模式：pointerdown 只做一次 detail 命中，绝不派发页面 mousePressed。
        if (pickRef.current.on) {
          if (event.button !== 0) return;
          event.preventDefault();
          pickCommitAt(event);
          return;
        }
        if (event.button === 2) {
          if (!frameInputReady()) return;
          const rightGeom = frameGeometry();
          const rightPoint = rightGeom ? mapEventPoint(event, rightGeom) : null;
          if (!rightPoint || !rightPoint.inside || rightPoint.blank) return;
          event.preventDefault();
          event.currentTarget.focus();
          openPageContext(event, rightPoint);
          return;
        }
        if (event.button !== 0) return;
        if (panMode) {
          // Pan is the recovery path: it must start even when page input is fail-closed (stale
          // seed/frame), otherwise a viewport panned fully off-content would be a dead end.
          if (!readyRef.current || writesPausedRef.current || !canvasActive()) return;
          const geom = frameGeometry();
          if (!geom) return;
          const point = mapEventPoint(event, geom);
          if (!point.inside) return; // letterbox: no pan start there either
          event.preventDefault();
          const canvas = canvasPosition();
          if (!canvas) return; // no canvas Host: drag is disabled, never fall back to scroll panning
          panDragRef.current = {
            active: true,
            pointerId: event.pointerId,
            startClientX: event.clientX,
            startClientY: event.clientY,
            startX: canvas.x,
            startY: canvas.y,
            geom,
            viewW: Number(viewRef.current.width) || pageSize.w,
            viewH: Number(viewRef.current.height) || pageSize.h,
          };
          setPanDragging(true);
          try { event.currentTarget.setPointerCapture(event.pointerId); } catch { /* ignore */ }
          return; // 拖拽模式：不向页面派发 mousePressed
        }
        if (!frameInputReady()) return;
        const geom = frameGeometry();
        if (!geom) return;
        const point = mapEventPoint(event, geom);
        if (!point.inside) return; // letterbox: zero dispatch
        if (point.blank) { showBlankHint(); return; } // canvas blank: zero dispatch
        setBlankHint('');
        event.preventDefault();
        event.currentTarget.focus();
        dragRef.current = { active: true, pointerId: event.pointerId, x: point.x, y: point.y };
        selectClickRef.current = { x: event.clientX, y: event.clientY, pointerId: event.pointerId, valid: true };
        try { event.currentTarget.setPointerCapture(event.pointerId); } catch { /* ignore */ }
        sendEvents([{ kind: 'mouse', type: 'mousePressed', x: point.x, y: point.y, button: 'left', buttons: 1, clickCount: 1 }]);
      }

      /** CSS cursor 关键字白名单：页面只能在这几个值里改变预览光标。 */
      const PAGE_CURSOR_KEYWORDS = new Set([
        'auto', 'default', 'pointer', 'text', 'move', 'grab', 'grabbing', 'crosshair', 'wait', 'help',
        'progress', 'cell', 'copy', 'alias', 'context-menu', 'not-allowed', 'no-drop', 'zoom-in',
        'zoom-out', 'all-scroll', 'vertical-text', 'col-resize', 'row-resize', 'n-resize', 's-resize',
        'e-resize', 'w-resize', 'ne-resize', 'nw-resize', 'se-resize', 'sw-resize', 'ew-resize',
        'ns-resize', 'nesw-resize', 'nwse-resize', 'none',
      ]);
      function pageCursorKeyword(raw) {
        const value = typeof raw === 'string' ? raw.trim().toLowerCase() : '';
        return PAGE_CURSOR_KEYWORDS.has(value) ? value : 'auto';
      }
      /**
       * 光标形状传递（`POST /element {cursorOnly:true}`）。
       *
       * 页面里 `cursor:pointer` 的元素在真实浏览器里是手型，但面板把画面画成 <img>，指针形状来自
       * 面板自己的 CSS —— 于是"里面是手型、外面是箭头"。这里按节流询问页面命中的 computed cursor
       * 并写回预览层；迟到的响应按序号丢弃，避免快速移动时旧位置的光标覆盖新位置。
       */
      // 面板侧"以为还按着"的键（code → 键信息），用于焦点离开时补 keyUp。
      const panelHeldKeysRef = React.useRef(new Map());
      const cursorProbeAtRef = React.useRef(0);
      const cursorProbeSeqRef = React.useRef(0);
      const cursorProbeTimerRef = React.useRef(0);
      const cursorProbePointRef = React.useRef(null);
      function resetFrameCursor() {
        cursorProbeSeqRef.current += 1;
        if (cursorProbeTimerRef.current) window.clearTimeout(cursorProbeTimerRef.current);
        cursorProbeTimerRef.current = 0;
        cursorProbePointRef.current = null;
        cursorProbeAtRef.current = 0;
        setFrameCursor('auto');
      }
      function frameCursorAllowed() {
        return visibleRef.current && readyRef.current && !writesPausedRef.current
          && !annotRef.current.on && !pickRef.current.on && !panModeRef.current;
      }
      function probeFrameCursor() {
        cursorProbeTimerRef.current = 0;
        const client = cursorProbePointRef.current;
        if (!client || !frameCursorAllowed()) { resetFrameCursor(); return; }
        const geom = frameGeometry();
        const canvas = canvasPosition();
        if (!geom || !canvas || !inputGeomReady() || !canvasBarrier().ready) {
          // A replacement image may have naturalWidth=0 until decoded. Keep the final hover
          // through that brief gap as well as input-barrier gaps, with a bounded retry.
          if (Date.now() < client.expiresAt) cursorProbeTimerRef.current = window.setTimeout(probeFrameCursor, 120);
          else resetFrameCursor();
          return;
        }
        // Re-map the latest pointer at dispatch time; a trailing probe must not reuse old geometry.
        const point = mapEventPoint(client, geom);
        if (!point.inside || point.blank) { resetFrameCursor(); return; }
        const seq = cursorProbeSeqRef.current;
        const epoch = scopeEpochRef.current;
        const documentKey = selectPopDocument();
        const canvasKey = selectPopCanvas();
        const current = () => seq === cursorProbeSeqRef.current && epoch === scopeEpochRef.current
          && documentKey === selectPopDocument() && canvasKey === selectPopCanvas() && frameCursorAllowed();
        cursorProbeAtRef.current = Date.now();
        callHost('element', { x: point.q.x + canvas.x, y: point.q.y + canvas.y, cursorOnly: true }, {
          scope: scopeRef.current,
          signal: abortRef.current ? abortRef.current.signal : undefined,
        }).then((reply) => {
          if (!current()) return;
          const element = reply && reply.element ? reply.element : null;
          setFrameCursor(pageCursorKeyword(element && element.cursor));
        }).catch(() => { if (current()) setFrameCursor('auto'); });
      }
      function scheduleFrameCursor(event) {
        // Invalidate the previous position even when this move falls inside the throttle window.
        cursorProbeSeqRef.current += 1;
        cursorProbePointRef.current = { clientX: event.clientX, clientY: event.clientY, expiresAt: Date.now() + 1000 };
        if (cursorProbeTimerRef.current) return;
        const wait = 120 - (Date.now() - cursorProbeAtRef.current);
        if (wait <= 0) probeFrameCursor();
        else cursorProbeTimerRef.current = window.setTimeout(probeFrameCursor, wait);
      }
      const cursorDocumentKey = selectPopDocument();
      const cursorCanvasKey = selectPopCanvas();
      React.useEffect(() => {
        resetFrameCursor();
        return resetFrameCursor;
      }, [scopeEpoch, cursorDocumentKey, cursorCanvasKey, visible, ready, identity.paused, panMode, annotOn, pickOn]);

      function onFramePointerMove(event) {
        if (annotRef.current.on) return; // annotation mode: zero page input
        // 选元素模式：悬浮只更新节流命中请求，零页面 hover 派发。
        if (pickRef.current.on) {
          pickScheduleHover(event.clientX, event.clientY);
          return;
        }
        if (!readyRef.current || writesPausedRef.current) return;
        const pan = panDragRef.current;
        if (pan.active && pan.pointerId === event.pointerId) {
          event.preventDefault();
          const next = panViewPoint(event, pan);
          requestPanWrite(next.x, next.y);
          return;
        }
        if (panMode) return; // 拖拽模式：不向页面派发 hover/拖拽移动
        // Retain the last hover even if frame sync briefly blocks page input.
        scheduleFrameCursor(event);
        // Fail closed for page input while O≠0 cannot be proven: no stale-coordinate move/release.
        if (!inputGeomReady() || !canvasBarrier().ready) return;
        const drag = dragRef.current;
        const dragging = drag.active && drag.pointerId === event.pointerId;
        const geom = frameGeometry();
        if (!geom) return;
        const point = mapEventPoint(event, geom);
        if (!point.inside) return;
        if (point.blank) { resetFrameCursor(); return; } // blank never dispatches (a drag into blank keeps its button state)
        const now = Date.now();
        if (now - hoverAtRef.current < 60) return;
        hoverAtRef.current = now;
        if (dragging) dragRef.current = { active: true, pointerId: event.pointerId, x: point.x, y: point.y };
        sendEvents([{ kind: 'mouse', type: 'mouseMoved', x: point.x, y: point.y, buttons: dragging ? 1 : 0 }]);
      }

      /** 不支持浮层的形态 → 原因字符串（null = 支持）。与 Host 侧 selectShapeSupport 同义。 */
      function selectPopReason(projection) {
        if (!projection) return 'detached';
        if (projection.multiple === true) return 'multiple';
        if (Number(projection.size) > 1) return 'size';
        if (!projection.options || projection.options.length === 0) return 'empty';
        return null;
      }

      function selectPopClose(restoreFocus = false) {
        selectPopSeqRef.current += 1;
        selectPopRef.current = null;
        setSelectPop(null);
        if (restoreFocus && frameImgRef.current) frameImgRef.current.focus({ preventScroll: true });
      }

      function selectPopDocument() {
        const state = remoteRef.current;
        const ui = state && state.ui;
        return annotDKey(annotDOf(ui)) + '|' + String(ui && ui.address || state && state.url || '');
      }

      function selectPopCanvas() {
        const canvas = canvasPosition();
        const view = viewRef.current;
        return canvas ? JSON.stringify([canvas.x, canvas.y, view && view.scale]) : '';
      }

      function selectPopIsCurrent(pop) {
        // A visible hint survives newer probes; only their responses/option popovers depend on seq.
        return pop && pop.epoch === scopeEpochRef.current && (pop.reason || pop.seq === selectPopSeqRef.current)
          && pop.document === selectPopDocument() && pop.canvas === selectPopCanvas()
          && readyRef.current && !writesPausedRef.current && !annotRef.current.on && !pickRef.current.on;
      }

      /**
       * 一次点击之后问 Host 命中了什么：命中 <select> 就在点击点画浮层。
       * 全部复用 picker 的坐标换算（q + 画布偏移 = 页面文档坐标），并沿用"画布原点移动就丢弃"
       * 的规则，避免浮层画在错位的位置。
       */
      function selectPopProbe(event, point) {
        if (!readyRef.current || writesPausedRef.current) return;
        const canvas = canvasPosition();
        const box = frameBoxRef.current;
        if (!canvas || !box) return;
        const rect = box.getBoundingClientRect();
        const epoch = scopeEpochRef.current;
        const seq = selectPopSeqRef.current + 1;
        selectPopSeqRef.current = seq;
        const signal = abortRef.current ? abortRef.current.signal : undefined;
        const context = { epoch, seq, scope: scopeRef.current, document: selectPopDocument(), canvas: selectPopCanvas() };
        callHost('element', { x: point.q.x + canvas.x, y: point.q.y + canvas.y, detail: false }, {
          scope: context.scope,
          signal,
        }).then((payload) => {
          if (!selectPopIsCurrent(context)) return;
          const element = payload && payload.element;
          const projection = element && element.select ? element.select : null;
          if (!projection || !projection.target) { selectPopClose(); return; }
          const reason = selectPopReason(projection);
          const current = selectPopRef.current;
          // Keep the existing DOM/live region until dismissal instead of re-triggering the hint.
          if (reason && current?.reason && selectPopIsCurrent(current)) return;
          const options = projection.options || [];
          const selectedIndex = options.findIndex((option) => option.selected);
          setSelectPop({
            ...context,
            anchor: { x: event.clientX - rect.left, y: event.clientY - rect.top },
            bounds: { width: rect.width, height: rect.height },
            select: projection,
            reason,
            activeIndex: selectedIndex >= 0 ? selectedIndex : 0,
          });
        }).catch(() => {
          if (selectPopIsCurrent(context)) selectPopClose();
        });
      }

      /** 选中一项：写回 → 补一次 Escape 关掉可能已打开的原生弹层 → 收起浮层。 */
      function selectPopChoose(option) {
        const pop = selectPopRef.current;
        if (!selectPopIsCurrent(pop) || pop.reason || !option || option.disabled) return;
        const signal = abortRef.current ? abortRef.current.signal : undefined;
        const optionIndex = pop.select.options.indexOf(option);
        selectPopClose(true);
        const settleEscape = () => {
          if (pop.epoch !== scopeEpochRef.current || pop.document !== selectPopDocument()) return;
          sendEvents([
            { kind: 'key', type: 'keyDown', key: 'Escape', code: 'Escape', virtualKeyCode: 27, modifiers: 0 },
            { kind: 'key', type: 'keyUp', key: 'Escape', code: 'Escape', virtualKeyCode: 27, modifiers: 0 },
          ]);
        };
        callHost('select', { value: option.value, optionIndex, target: pop.select.target }, { scope: pop.scope, signal })
          .then((payload) => {
            if (!payload || payload.ok !== true) {
              noteInputError(new Error('下拉写入失败'));
              return;
            }
            // 顺序很重要：先写回再 Escape。反过来的话，Escape 会先把用户刚选的值撤销掉。
            settleEscape();
          })
          .catch((error) => { noteInputError(error); });
      }

      /** 浮层内键盘：↑↓ 移动（跳过 disabled）、Enter 选中、Esc 关闭；不支持形态只有 Esc。 */
      function onSelectPopKeyDown(event) {
        const pop = selectPopRef.current;
        if (!pop) return;
        if (event.key === 'Escape' || event.key === 'Esc') {
          event.preventDefault();
          event.stopPropagation();
          selectPopClose(true);
          sendEvents(panelKeyEvents(event));
          return;
        }
        if (pop.reason) {
          const events = panelKeyEvents(event);
          if (events.length) { event.preventDefault(); sendEvents(events); }
          return;
        }
        const options = pop.select.options || [];
        if (event.key === 'ArrowDown' || event.key === 'ArrowUp') {
          event.preventDefault();
          event.stopPropagation();
          if (!options.length) return;
          const step = event.key === 'ArrowDown' ? 1 : -1;
          let index = Number.isInteger(pop.activeIndex) ? pop.activeIndex : 0;
          for (let hop = 0; hop < options.length; hop += 1) {
            index = (index + step + options.length) % options.length;
            if (!options[index].disabled) break;
          }
          setSelectPop(Object.assign({}, pop, { activeIndex: index }));
          return;
        }
        if (event.key === 'Enter') {
          event.preventDefault();
          event.stopPropagation();
          const option = options[pop.activeIndex];
          if (option && !option.disabled) selectPopChoose(option);
        }
      }

      /** 点击浮层外部关闭（面板任意位置，含画面区的下一次按下）。 */
      React.useEffect(() => {
        const onDocumentPointerDown = (event) => {
          const node = selectPopElementRef.current;
          if (node && event.target && typeof node.contains === 'function' && node.contains(event.target)) return;
          // Re-clicking page controls must not collapse/reinsert the outside-preview hint row.
          if (selectPopRef.current?.reason && frameImgRef.current?.contains(event.target)) return;
          selectPopClose();
        };
        document.addEventListener('pointerdown', onDocumentPointerDown, true);
        return () => document.removeEventListener('pointerdown', onDocumentPointerDown, true);
      }, []);

      React.useEffect(() => {
        if (selectPopRef.current && !selectPopIsCurrent(selectPopRef.current)) selectPopClose();
      });

      function closePageContext(restoreFocus = false) {
        pageContextSeqRef.current += 1;
        pageContextRef.current = null;
        setPageContext(null);
        if (restoreFocus && frameImgRef.current) frameImgRef.current.focus({ preventScroll: true });
      }

      function pageContextCurrent(context) {
        return context && context.seq === pageContextSeqRef.current && context.epoch === scopeEpochRef.current
          && context.document === selectPopDocument() && context.canvas === selectPopCanvas()
          && readyRef.current && !writesPausedRef.current && !annotRef.current.on && !pickRef.current.on;
      }

      function openPageContext(event, point) {
        closePageContext();
        selectPopClose();
        const box = frameBoxRef.current;
        if (!box) return;
        const rect = box.getBoundingClientRect();
        const context = { seq: pageContextSeqRef.current, epoch: scopeEpochRef.current, scope: scopeRef.current,
          document: selectPopDocument(), canvas: selectPopCanvas(),
          anchor: { x: event.clientX - rect.left, y: event.clientY - rect.top },
          bounds: { width: rect.width, height: rect.height } };
        const signal = abortRef.current?.signal;
        const modifiers = (event.altKey ? 1 : 0) | (event.ctrlKey ? 2 : 0) | (event.metaKey ? 4 : 0) | (event.shiftKey ? 8 : 0);
        const pending = inputQueueRef.current.then(async () => {
          if (!pageContextCurrent(context) || !frameInputReady()) return;
          const payload = await callHost('context-menu', { x: point.x, y: point.y, modifiers }, { scope: context.scope, signal });
          if (context.seq !== pageContextSeqRef.current || context.epoch !== scopeEpochRef.current || signal?.aborted) return;
          // A fresh frame may arrive before /state after reload. Bind to the document observed by
          // THIS transaction, while acceptRemote's revision gate rejects a late/retired snapshot.
          const state = payload.state;
          const responseDocument = state && (annotDKey(annotDOf(state.ui)) + '|' + String(state.ui?.address || state.url || ''));
          if (!responseDocument || (context.document !== selectPopDocument() && responseDocument !== selectPopDocument())) return;
          acceptRemote(state);
          const observed = { ...context, document: responseDocument };
          if (!pageContextCurrent(observed)) return;
          setInputNotice('');
          if (payload.status === 'default' && payload.menu) {
            setPageContext({ ...observed, ...payload.menu, activeIndex: payload.menu.items.findIndex(item => !item.disabled) });
          }
        }).catch(error => { if (pageContextCurrent(context)) noteInputError(error); });
        inputQueueRef.current = pending;
      }

      function choosePageContext(item) {
        const context = pageContextRef.current;
        if (!pageContextCurrent(context) || !item || item.disabled) return;
        // Start clipboard access in the real user gesture, before any asynchronous Host request.
        const copied = item.text ? clipboardWriteText(item.text) : null;
        closePageContext(true);
        if (copied) {
          copied.then(ok => {
            if (ok || context.epoch !== scopeEpochRef.current || context.document !== selectPopDocument()) return;
            setInputNotice('无法访问剪贴板，请检查浏览器权限');
            window.clearTimeout(inputNoticeTimerRef.current);
            inputNoticeTimerRef.current = window.setTimeout(() => setInputNotice(''), 3200);
          });
          return;
        }
        const signal = abortRef.current?.signal;
        const pending = inputQueueRef.current.then(async () => {
          if (context.epoch !== scopeEpochRef.current || context.document !== selectPopDocument()) return;
          const payload = await callHost('context-action', { token: context.token, action: item.id }, { scope: context.scope, signal });
          if (context.epoch === scopeEpochRef.current && !signal?.aborted && payload.state) acceptRemote(payload.state);
        }).catch(error => { if (context.epoch === scopeEpochRef.current) noteInputError(error); });
        inputQueueRef.current = pending;
      }

      function onPageContextKeyDown(event) {
        const context = pageContextRef.current;
        if (!context) return;
        event.preventDefault();
        event.stopPropagation();
        if (event.key === 'Escape' || event.key === 'Tab') { closePageContext(true); return; }
        if (event.key === 'Enter' || event.key === ' ') { choosePageContext(context.items[context.activeIndex]); return; }
        if (!['ArrowDown', 'ArrowUp', 'Home', 'End'].includes(event.key)) return;
        const enabled = context.items.map((item, index) => item.disabled ? -1 : index).filter(index => index >= 0);
        let index = enabled.indexOf(context.activeIndex);
        index = event.key === 'Home' ? 0 : event.key === 'End' ? enabled.length - 1
          : (index + (event.key === 'ArrowUp' ? -1 : 1) + enabled.length) % enabled.length;
        setPageContext({ ...context, activeIndex: enabled[index] });
      }

      React.useEffect(() => {
        const outside = event => {
          if (pageContextElementRef.current?.contains(event.target)) return;
          closePageContext();
        };
        const scroll = event => {
          const target = event?.target;
          const preview = stage.current;
          // Sibling panes (especially the streaming chat) do not move this menu's anchor.
          if (event?.type !== 'scroll' || target === document || target === window
            || (target?.contains && preview && target.contains(preview))
            || (preview?.contains(target) && !pageContextElementRef.current?.contains(target))) closePageContext();
        };
        document.addEventListener('pointerdown', outside, true);
        window.addEventListener('blur', scroll);
        window.addEventListener('resize', scroll);
        // Scroll can move the anchor without a React render (including stage/ancestor scrolling).
        document.addEventListener('scroll', scroll, true);
        return () => {
          document.removeEventListener('pointerdown', outside, true);
          window.removeEventListener('blur', scroll);
          window.removeEventListener('resize', scroll);
          document.removeEventListener('scroll', scroll, true);
        };
      }, []);
      React.useEffect(() => {
        if (pageContextRef.current && !pageContextCurrent(pageContextRef.current)) closePageContext();
      });

      /**
       * 预览区内部的右键菜单属于页面，不属于宿主。
       *
       * 宿主（DSH Web）把右键菜单挂在容器上（`useContextMenu` 的 trigger props → React
       * `onContextMenu`），预览是它的子树，所以右键会弹宿主的菜单。这里在预览区域内
       * `preventDefault + stopPropagation`：既不弹宿主菜单，也不让事件继续冒泡到宿主容器。
       * 页面右键由 Host 完整事务派发；未被页面取消时显示面板菜单。
       */
      function onFrameContextMenu(event) {
        event.preventDefault();
        event.stopPropagation();
      }

      /** The release is dispatched even when the pointer left the image (no stuck button). */
      function onFramePointerUp(event) {
        if (event.button === 2) return; // Host already paired press/release, even outside the image.
        if (annotRef.current.on) return; // annotation mode: zero page input
        if (pickRef.current.on) return; // pick mode: action already committed on pointerdown
        const pan = panDragRef.current;
        if (pan.active && pan.pointerId === event.pointerId) {
          const moved = Math.abs(event.clientX - pan.startClientX) > 0.5 || Math.abs(event.clientY - pan.startClientY) > 0.5;
          if (moved) {
            const next = panViewPoint(event, pan);
            requestPanWrite(next.x, next.y);
          }
          flushPanWrite();
          try { event.currentTarget.releasePointerCapture(event.pointerId); } catch { /* ignore */ }
          cancelPanDrag();
          return;
        }
        const drag = dragRef.current;
        if (!drag.active || drag.pointerId !== event.pointerId) return;
        dragRef.current = { active: false, pointerId: -1, x: drag.x, y: drag.y };
        const geom = frameGeometry();
        const point = geom ? mapEventPoint(event, geom) : null;
        let released = Promise.resolve(false);
        const probeContext = { epoch: scopeEpochRef.current, seq: selectPopSeqRef.current, document: selectPopDocument(), canvas: selectPopCanvas() };
        if (point) {
          const size = acceptedViewSize();
          released = sendEvents([{
            kind: 'mouse',
            type: 'mouseReleased',
            x: clampNumber(point.x, 0, Math.max(0, size.w - POINTER_EPSILON)),
            y: clampNumber(point.y, 0, Math.max(0, size.h - POINTER_EPSILON)),
            button: 'left',
            buttons: 0,
            clickCount: 1,
          }]);
        }
        try { event.currentTarget.releasePointerCapture(event.pointerId); } catch { /* ignore */ }
        // 原生 <select>：点击（非拖拽、非空白）之后问一次命中。浮层由浏览器 UI 图层绘制，
        // 帧里看不到，所以这里用同一坐标向 Host 取选项，在点击点画面板自己的列表。
        if (point) {
          const pressed = selectClickRef.current;
          const moved = !pressed.valid
            || pressed.pointerId !== event.pointerId
            || Math.abs(event.clientX - pressed.x) > SELECT_CLICK_SLOP_PX
            || Math.abs(event.clientY - pressed.y) > SELECT_CLICK_SLOP_PX;
          selectClickRef.current = { x: 0, y: 0, pointerId: -1, valid: false };
          if (!moved && !point.blank) {
            const click = { clientX: event.clientX, clientY: event.clientY };
            released.then((applied) => {
              if (applied && selectPopIsCurrent(probeContext)) selectPopProbe(click, point);
            });
          }
        }
      }

      /** Best-effort release for pointercancel / lost capture / blur while dragging. */
      function releaseFrameDrag() {
        if (annotRef.current.on) return; // annotation mode: never dispatch a page release
        // 选元素模式：只取消本地拖拽状态，绝不派发页面 release。
        if (pickRef.current.on) {
          cancelPanDrag();
          const pendingDrag = dragRef.current;
          if (pendingDrag.active) dragRef.current = { active: false, pointerId: -1, x: pendingDrag.x, y: pendingDrag.y };
          return;
        }
        if (panDragRef.current.active) {
          flushPanWrite();
          cancelPanDrag();
        }
        const drag = dragRef.current;
        if (!drag.active) return;
        dragRef.current = { active: false, pointerId: -1, x: drag.x, y: drag.y };
        sendEvents([{ kind: 'mouse', type: 'mouseReleased', x: drag.x, y: drag.y, button: 'left', buttons: 0, clickCount: 1 }]);
      }

      /** Active (recent) pan-wheel zoom intent; null once the notch settled or expired. */
      function activeZoomIntent() {
        const intent = zoomIntentRef.current;
        return intent && intent.scale !== null && Date.now() - intent.at < 5000 ? intent : null;
      }

      function zoomDebug(event, data) {
        try {
          const list = window.__utbZoomDebug || (window.__utbZoomDebug = []);
          list.push(Object.assign({ event, t: Date.now() }, data || {}));
          if (list.length > 80) list.shift();
        } catch { /* diagnostics must never break the panel */ }
      }

      function clearZoomIntent(reason) {
        if (zoomIntentRef.current.scale !== null) zoomDebug('clear-intent', { reason: reason || 'unspecified', scale: zoomIntentRef.current.scale });
        zoomIntentRef.current = { scale: null, x: null, y: null, w: null, h: null, at: 0 };
        canvasZoomRef.current = { scale: null, x: null, y: null, at: 0 };
      }

      function resetZoomAnchor() {
        zoomAnchorRef.current = {
          id: zoomAnchorRef.current.id, active: false, corrected: false, scheduled: false,
          d: null, screen: null, scale: null, w: null, h: null,
        };
        setZoomAnchor('screen');
        setZoomAnchorState('idle');
      }

      /**
       * One post-layout check of the strict screen anchor: the canvas point under the cursor must
       * stay at the same screen point. Drift 1–20 px gets one bounded C-only correction (same scale,
       * latest revision, normal CAS/conflict retry); >20 px or missing geometry degrades to the
       * box-relative anchor and is marked `data-utb-canvas-zoom-anchor="box"`.
       */
      function scheduleZoomAnchorCheck() {
        const anchor = zoomAnchorRef.current;
        const view = viewRef.current;
        if (!anchor || !anchor.active || anchor.scheduled || !anchor.d || !view) return;
        if (!Number.isFinite(Number(anchor.scale)) || Math.abs(Number(view.scale) - Number(anchor.scale)) > 0.0011) return;
        anchor.scheduled = true;
        const anchorId = anchor.id;
        window.requestAnimationFrame(() => window.requestAnimationFrame(() => checkZoomAnchor(anchorId)));
      }

      function checkZoomAnchor(anchorId) {
        const anchor = zoomAnchorRef.current;
        if (!anchor || anchor.id !== anchorId) return;
        anchor.scheduled = false;
        if (!anchor.active) return;
        const view = viewRef.current;
        const box = frameBoxRef.current;
        if (!view || !box || !anchor.d || !(Number(anchor.w) > 0)) {
          anchor.active = false;
          setZoomAnchor('box');
          setZoomAnchorState('box');
          return;
        }
        const rect = box.getBoundingClientRect();
        const scaleActual = rect.width / Number(anchor.w);
        if (!(rect.width > 0) || !(scaleActual > 0)) {
          anchor.active = false;
          setZoomAnchor('box');
          setZoomAnchorState('box');
          return;
        }
        const onScreen = {
          x: rect.left + (anchor.d.x - Number(view.canvasX)) * scaleActual,
          y: rect.top + (anchor.d.y - Number(view.canvasY)) * scaleActual,
        };
        const driftX = onScreen.x - anchor.screen.x;
        const driftY = onScreen.y - anchor.screen.y;
        const drift = Math.max(Math.abs(driftX), Math.abs(driftY));
        zoomDebug('anchor-check', { drift, driftX, driftY, corrected: anchor.corrected, rect: { left: rect.left, top: rect.top, width: rect.width } });
        if (drift <= 1) {
          anchor.active = false;
          setZoomAnchorState('settled');
          return;
        }
        if (drift > 20 || anchor.corrected) {
          anchor.active = false;
          setZoomAnchor('box');
          setZoomAnchorState('box');
          return;
        }
        anchor.corrected = true;
        const cx = clampNumber(anchor.d.x - (anchor.screen.x - rect.left) / scaleActual, VIEW_LIMITS.canvas[0], VIEW_LIMITS.canvas[1]);
        const cy = clampNumber(anchor.d.y - (anchor.screen.y - rect.top) / scaleActual, VIEW_LIMITS.canvas[0], VIEW_LIMITS.canvas[1]);
        const target = {
          scale: Number(anchor.scale), x: roundCanvas(cx), y: roundCanvas(cy),
          w: anchor.w, h: anchor.h, at: Date.now(),
        };
        canvasZoomRef.current = target;
        zoomIntentRef.current = target;
        setZoomAnchorState('correcting');
        zoomDebug('anchor-correct', { drift, targetScale: target.scale, targetX: target.x, targetY: target.y });
        queueViewPatch({ scale: target.scale, x: target.x, y: target.y }, 0);
      }

      /**
       * Pan-mode wheel zoom (user request 2026-11-02): change the shared canvas scale around the
       * cursor. Steps reuse the size-bar scale wheel (5/10/1 %, Alt > Shift, 0.1–2.0) and publish
       * `scale + canvasX + canvasY` in one v1/CAS patch (never x/y). If fit is checked it is
       * unlocked through the manual-scale path. Boundary hits are consumed but send nothing.
       */
      function zoomCanvasByWheel(event) {
        // Scale zoom is not a page-input write: do not let a transient main-view/geometry pause
        // swallow the notch (that pause gates pointer/scroll dispatch, not the shared view).
        if (!readyRef.current || !canvasActive()) { zoomDebug('skip', { reason: 'not-ready' }); return; }
        if (event.ctrlKey || event.metaKey) return; // nothing changes (and the caller consumes it)
        // Alt+wheel can be delivered as a horizontal wheel on some platforms: direction uses
        // whichever axis actually moved (deltaY first, then deltaX).
        const wheelDelta = event.deltaY || event.deltaX;
        if (!wheelDelta) { zoomDebug('skip', { reason: 'zero-delta' }); return; }
        const view = viewRef.current;
        const box = frameBoxRef.current;
        if (!view || !box) return;
        const rect = box.getBoundingClientRect();
        if (!(rect.width > 0) || !(rect.height > 0)) return;
        event.preventDefault();
        event.stopPropagation();
        markHuman();
        zoomRetryRef.current = 0; // this is a new user notch; it may replay once on CAS conflict
        const size = acceptedViewSize();
        if (!(size.w > 0) || !(size.h > 0)) return;
        const intent = activeZoomIntent();
        const boxScale = rect.width / size.w;
        const acceptedScale = Number(view.scale);
        // User intent (survives state polls) -> accepted view.scale -> box measurement (box is only a
        // fallback; a mid-layout box rect must not shift the percentage step).
        const fromScale = intent
          ? intent.scale
          : (fitRef.current
            ? (fitScaleValue() > 0 ? fitScaleValue() : boxScale)
            : (Number.isFinite(acceptedScale) && acceptedScale > 0 ? acceptedScale : (boxScale > 0 ? boxScale : 1)));
        if (!(fromScale > 0)) return;
        const anchorC = canvasPosition();
        const b = {
          x: clampNumber(event.clientX - rect.left, 0, rect.width),
          y: clampNumber(event.clientY - rect.top, 0, rect.height),
        };
        const steps = WHEEL_STEPS.scale;
        const alt = Boolean(event.altKey);
        const shift = Boolean(event.shiftKey) && !alt;
        const step = alt ? steps.alt : shift ? steps.shift : steps.normal;
        const direction = wheelDelta < 0 ? 1 : -1;
        const basePercent = Math.round(fromScale * 100);
        const nextPercent = clampNumber(basePercent + direction * step, VIEW_LIMITS.scalePercent[0], VIEW_LIMITS.scalePercent[1]);
        if (nextPercent === basePercent) { zoomDebug('skip', { reason: 'boundary', basePercent, step, direction }); return; } // boundary: no request and no fit unlock
        const nextScale = nextPercent / 100;
        // Manual-scale path: fit unlocks now and the 500ms poll must not re-check it.
        fitRef.current = false;
        setFit(false);
        setZoom(String(nextPercent));
        noteViewEdit('scale', nextPercent);
        viewWheelRef.current.scale = viewEditRef.current.scale;
        const patch = { scale: nextScale };
        const screenPoint = { x: event.clientX, y: event.clientY };
        const displayScale = boxScale > 0 ? boxScale : (fromScale > 0 ? fromScale : 1);
        const stageNode = stage.current;
        let anchorMode = 'box';
        let targetX = null;
        let targetY = null;
        let anchorD = null;
        let predictedLeft = rect.left;
        let predictedTop = rect.top;
        if (anchorC && displayScale > 0) {
          if (stageNode) {
            const sr = stageNode.getBoundingClientRect();
            const stageW = stageNode.clientWidth;
            const stageH = stageNode.clientHeight;
            const centeredX = stageW > 0 && Math.abs((sr.left + stageW / 2) - (rect.left + rect.width / 2)) <= 1;
            const centeredY = stageH > 0 && Math.abs((sr.top + stageH / 2) - (rect.top + rect.height / 2)) <= 1;
            // Predict where the centered box lands after the scale change; a non-centered axis keeps
            // its measured left/top (the stage then scrolls/clips and the post-layout check decides).
            predictedLeft = centeredX ? sr.left + (stageW - size.w * nextScale) / 2 : rect.left;
            predictedTop = centeredY ? sr.top + (stageH - size.h * nextScale) / 2 : rect.top;
            anchorD = {
              x: anchorC.x + (screenPoint.x - rect.left) / displayScale,
              y: anchorC.y + (screenPoint.y - rect.top) / displayScale,
            };
            targetX = clampNumber(anchorD.x - (screenPoint.x - predictedLeft) / nextScale, VIEW_LIMITS.canvas[0], VIEW_LIMITS.canvas[1]);
            targetY = clampNumber(anchorD.y - (screenPoint.y - predictedTop) / nextScale, VIEW_LIMITS.canvas[0], VIEW_LIMITS.canvas[1]);
            anchorMode = 'screen';
          } else {
            // No stage geometry: keep the existing box-relative formula (never drop the notch).
            const zoomFactor = 1 / displayScale - 1 / nextScale;
            targetX = clampNumber(anchorC.x + (screenPoint.x - rect.left) * zoomFactor, VIEW_LIMITS.canvas[0], VIEW_LIMITS.canvas[1]);
            targetY = clampNumber(anchorC.y + (screenPoint.y - rect.top) * zoomFactor, VIEW_LIMITS.canvas[0], VIEW_LIMITS.canvas[1]);
            anchorMode = 'box';
          }
          patch.x = roundCanvas(targetX);
          patch.y = roundCanvas(targetY);
          const target = { scale: nextScale, x: patch.x, y: patch.y, w: size.w, h: size.h, at: Date.now() };
          canvasZoomRef.current = target;
          zoomIntentRef.current = target;
          if (anchorMode === 'screen') {
            zoomAnchorRef.current = {
              id: zoomAnchorIdRef.current + 1,
              active: true, corrected: false, scheduled: false,
              d: anchorD, screen: screenPoint, scale: nextScale, w: size.w, h: size.h,
            };
            zoomAnchorIdRef.current += 1;
            setZoomAnchor('screen');
            setZoomAnchorState('checking');
          } else {
            zoomAnchorRef.current = { id: zoomAnchorRef.current.id, active: false, corrected: false, scheduled: false, d: null, screen: null, scale: null, w: null, h: null };
            setZoomAnchor('box');
            setZoomAnchorState('box');
          }
        } else {
          // No box/canvas geometry: degrade to a scale-only zoom; the notch is still published.
          zoomAnchorRef.current = { id: zoomAnchorRef.current.id, active: false, corrected: false, scheduled: false, d: null, screen: null, scale: null, w: null, h: null };
          setZoomAnchor('box');
          setZoomAnchorState('box');
          canvasZoomRef.current = { scale: nextScale, x: null, y: null, w: size.w, h: size.h, at: Date.now() };
          zoomIntentRef.current = { scale: nextScale, x: null, y: null, w: size.w, h: size.h, at: Date.now() };
        }
        zoomDebug('notch', {
          fromScale, nextScale, anchorMode,
          fromX: anchorC && anchorC.x, fromY: anchorC && anchorC.y,
          targetX: patch.x, targetY: patch.y,
          predictedLeft, predictedTop, w: size.w, h: size.h,
        });
        queueViewPatch(patch);
      }

      /**
       * Page wheel dispatch. Only a point that passes geometry, blank and input gates reaches the
       * target page. The ordinary-wheel default is consumed by the stage handler before every early
       * return; this guard keeps a direct caller fail-closed as well.
       */
      function onFrameWheel(event) {
        if (annotRef.current.on) return; // annotation mode: the stage listener consumes it
        const pickMode = pickRef.current.on;
        const shellZoom = Boolean(event.ctrlKey || event.metaKey);
        if (!shellZoom && !event.defaultPrevented) {
          event.preventDefault();
          event.stopPropagation();
        }
        if (panMode) {
          zoomCanvasByWheel(event);
          return;
        }
        if (!frameInputReady()) return;
        const geom = frameGeometry();
        if (!geom) return;
        const point = mapEventPoint(event, geom);
        if (!point.inside) return; // only inside the painted frame dispatches
        if (point.blank) return; // canvas blank: zero dispatch, host scrolling already consumed
        event.preventDefault();
        event.stopPropagation();
        markHuman();
        setBlankHint('');
        const size = acceptedViewSize();
        sendEvents([{
          kind: 'wheel',
          x: point.x,
          y: point.y,
          deltaX: frameWheelDelta(event.deltaX, event.deltaMode, geom.width, size.w),
          deltaY: frameWheelDelta(event.deltaY, event.deltaMode, geom.height, size.h),
        }], pickMode ? { wheel: true } : undefined);
        // 选元素模式：滚动仍作用于目标页；稳定后按最后指针位置重取悬浮命中。
        if (pickMode) pickAfterWheel(event.clientX, event.clientY);
      }

      /**
       * Native non-passive stage wheel listener.
       *
       * Ordinary wheel (no Ctrl/Meta) anywhere inside the stage is consumed here, before any
       * geometry/blank/readiness early return, so the stage overflow and every scrollable ancestor
       * can never scroll the preview/host. Only after that does the event flow to onFrameWheel, which
       * may dispatch exactly one target-page wheel for a validated content point. Ctrl/Meta keeps the
       * shell/browser zoom semantics outside pan; pan/annotation keep their existing wheel behaviour.
       */
      function onStageWheel(event) {
        // Annotation mode owns every preview wheel (blank/letterbox/Ctrl/Meta included): consume it
        // without scrolling the page, changing C/scale or scrolling the host.
        if (annotRef.current.on) {
          event.preventDefault();
          event.stopPropagation();
          return;
        }
        const target = event.target;
        const shellZoom = Boolean(event.ctrlKey || event.metaKey);
        // Core fix: consume ordinary wheel before *all* early returns (blank, letterbox, stage
        // margin, frameInputReady=false, missing geometry, target outside the image).
        if (!shellZoom) {
          event.preventDefault();
          event.stopPropagation();
        }
        if (!target || !target.closest) return;
        if (panMode) {
          if (shellZoom) {
            // Consume so the shell/browser does not zoom while the user is in drag mode.
            event.preventDefault();
            event.stopPropagation();
            return;
          }
          // Drag mode zooms the canvas; this works on the composited blank too (overlay/box target).
          if (!target.closest('.utb-box')) return; // ordinary wheel already consumed
          onFrameWheel(event);
          return;
        }
        if (shellZoom) return; // host/browser zoom stays with the shell
        // Ordinary wheel was consumed above; onFrameWheel decides whether this point dispatches.
        onFrameWheel(event);
      }

      React.useEffect(() => {
        const node = stage.current;
        if (!node) return;
        const update = () => setRoom({ w: node.clientWidth, h: node.clientHeight });
        update();
        if (typeof ResizeObserver === 'undefined') {
          window.addEventListener('resize', update);
          return () => window.removeEventListener('resize', update);
        }
        const observer = new ResizeObserver(update);
        observer.observe(node);
        return () => observer.disconnect();
      }, []);

      const pageSize = { w: Math.max(200, Math.min(4096, Number(width) || 200)), h: Math.max(200, Math.min(4096, Number(height) || 200)) };

      // One immutable scope/binding snapshot per generation. Identity or binding changes retire
      // every transport/poll/request and all UI state derived from the previous workspace.
      React.useEffect(() => {
        // v3 §12.1: a binding/identity transition must not erase the workspace document. Hand any
        // unconfirmed content to the module queue under the old frozen identity *before* the old
        // remote/view refs are dropped, then retract this panel's local view only.
        annotRetainDirty(true);
        selectPopClose();
        inputQueueRef.current = Promise.resolve();
        selectClickRef.current.valid = false;
        requestGenerationRef.current += 1;
        if (abortRef.current) abortRef.current.abort();
        abortRef.current = new AbortController();
        remoteRef.current = null;
        retiredRuntimeRef.current = '';
        dirtyRef.current = false;
        editVersionRef.current += 1;
        pendingRef.current = { active: false };
        setPending(false);
        setNavBusy(false);
        setDraft('');
        setRemote({ mode: 'idle', activity: '', url: '', running: false });
        setError('');
        setActivity('无进行中的操作');
        setMode('idle');
        setTransportKind('poll');
        setShot('');
        if (shotUrlRef.current) {
          try { URL.revokeObjectURL(shotUrlRef.current); } catch { /* ignore */ }
          shotUrlRef.current = '';
        }
        for (const objectUrl of frameMetaRef.current.keys()) {
          try { URL.revokeObjectURL(objectUrl); } catch { /* ignore */ }
        }
        frameMetaRef.current.clear();
        // A new scope generation must never inherit the previous runtime's shared view, drafts,
        // frame geometry or in-flight size request.
        if (viewTimerRef.current) window.clearTimeout(viewTimerRef.current);
        viewTimerRef.current = 0;
        viewQueueRef.current = null;
        viewQueuedRef.current = null;
        viewQueueSpaceRef.current = null;
        viewQueuedSpaceRef.current = null;
        viewInFlightRef.current = false;
        viewRef.current = null;
        viewMetaRef.current = null;
        observedRef.current = null;
        canvasRef.current = null;
        setCanvasInfo(null);
        if (seedRefreshTimerRef.current) window.clearTimeout(seedRefreshTimerRef.current);
        seedRefreshTimerRef.current = 0;
        seedCheckKeyRef.current = '';
        seedAttemptKeyRef.current = '';
        viewDirtyRef.current = { x: null, y: null, width: null, height: null, scale: null };
        viewFocusRef.current = '';
        viewFirstBindRef.current = { epoch: scopeEpoch, done: false };
        selfViewRevisionRef.current = 0;
        frameGeomRef.current = null;
        pendingGeomRef.current = null;
        dragRef.current = { active: false, pointerId: -1, x: 0, y: 0 };
        panDragRef.current = {
          active: false, pointerId: -1, startClientX: 0, startClientY: 0,
          startX: 0, startY: 0, geom: null, viewW: 0, viewH: 0,
        };
        panWriteRef.current = { timer: 0, latest: null };
        clearZoomIntent();
        resetZoomAnchor();
        zoomRetryRef.current = 0;
        panModeRef.current = false;
        setPanMode(false);
        setPanDragging(false);
        // A scope/runtime generation change retracts this panel's local drawing and exits the
        // annotation mode; the tool/style preferences survive (panel-local UI state).
        annotEpochRef.current = null;
        annotDropLocalView({ exit: true });
        setFrameVersion(0);
        setViewVersion(0);
        displayTimes.current = [];
        displayLatencies.current = [];
        displayedRef.current = 0;
        perfRef.current = { fps: 0, frameMs: 0 };
        setFps(0);
        setFrameMs(0);
        return () => {
          if (abortRef.current) abortRef.current.abort();
          abortRef.current = null;
        };
      }, [resetKey]);

      // `recent` is pinned once: the first /state (or /ensure) returns ui.runtimeId, and every
      // later request/WS carries that binding. A WS must never start on bare `recent`, because
      // the next request could resolve a different recent entry.
      React.useEffect(() => {
        if (!visible || identity.kind !== 'recent' || binding || legacyHost) return undefined;
        let cancelled = false;
        let retryTimer = 0;
        const controller = new AbortController();
        const scopeNow = scopeRef.current;
        const generation = requestGenerationRef.current;
        function retry() {
          if (cancelled) return;
          if (bindingAttemptsRef.current.count >= 3) return;
          retryTimer = window.setTimeout(run, 2500);
        }
        async function run() {
          if (cancelled) return;
          try {
            const state = await getHost('/state', scopeNow, controller.signal);
            if (cancelled || generation !== requestGenerationRef.current) return;
            if (hasScopeEvidence(state)) {
              const runtimeId = runtimeIdOf(state);
              if (runtimeId) {
                ingestHostState(state);
                adoptBinding(runtimeId);
                return;
              }
              // Scope-aware Host without a cold binding: one ensure is allowed to materialize it.
              if (identity.paused) return;
              bindingAttemptsRef.current.count += 1;
              const ensured = await callHost('ensure', {}, { scope: scopeNow, signal: controller.signal });
              if (cancelled || generation !== requestGenerationRef.current) return;
              const ensuredState = ensured && ensured.state ? ensured.state : ensured;
              const ensuredBinding = runtimeIdOf(ensured);
              if (ensuredBinding) {
                ingestHostState(ensuredState);
                adoptBinding(ensuredBinding);
                return;
              }
              if (hasScopeEvidence(ensured)) {
                ingestHostState(ensuredState);
                retry();
                return;
              }
              markLegacyHost();
              return;
            }
            // No scope evidence: old Host. Keep the panel displayable on the legacy browser,
            // but never claim workspace isolation.
            markLegacyHost();
            ingestHostState(state);
          } catch (error) {
            if (cancelled || (error && error.name === 'AbortError')) return;
            if (generation !== requestGenerationRef.current) return;
            // A child binding can disappear (window.close/Host retire/other panel close). Do not
            // keep the dead child selected or loop on its 404: fall back to the stable primary.
            if (activeViewId !== 'primary' && scopeNow.binding && error && error.code === 'SCOPE_NOT_FOUND') {
              viewSwitchRef.current = true;
              retiredRuntimeRef.current = '';
              setActiveViewId('primary');
              return;
            }
            retry();
          }
        }
        run();
        return () => { cancelled = true; window.clearTimeout(retryTimer); controller.abort(); };
      }, [visible, identity.kind, identityKey, binding, legacyHost, identity.paused]);

      // 画面传输：优先同源 WebSocket 推送，失败自动回退到 /frame HTTP 轮询。
      // Hidden sidebar tabs / a hidden document stop the WS and both poll loops without
      // closing the Host page or unmounting the component.
      React.useEffect(() => {
        if (!visible || !ready) return undefined;
        const scopeNow = scopeRef.current;
        let mounted = true;
        // A fresh transport per generation: old frames/object URLs never survive a rebuild.
        if (shotUrlRef.current) {
          try { URL.revokeObjectURL(shotUrlRef.current); } catch { /* ignore */ }
          shotUrlRef.current = '';
        }
        for (const objectUrl of frameMetaRef.current.keys()) {
          try { URL.revokeObjectURL(objectUrl); } catch { /* ignore */ }
        }
        frameMetaRef.current.clear();
        setShot('');
        const transport = createFrameTransport({
          onFrame({ blob, meta }) {
            if (!mounted) return;
            const nextUrl = URL.createObjectURL(blob);
            frameMetaRef.current.set(nextUrl, meta);
            const previous = shotUrlRef.current;
            shotUrlRef.current = nextUrl;
            setShot(nextUrl);
            if (previous) window.setTimeout(() => {
              URL.revokeObjectURL(previous);
              frameMetaRef.current.delete(previous);
            }, 2000);
          },
          onState(state) { if (mounted) ingestHostState(state); },
          onTransport(kind) { if (mounted) setTransportKind(kind); },
          onSeedStatus(status) {
            if (!mounted) return;
            setSeedStatus(status && status.state === 'failed'
              ? { reason: String(status.reason || 'unknown') }
              : null);
          },
          canWrite() { return !writesPausedRef.current && visibleRef.current; },
        }, scopeNow);
        transportRef.current = transport;
        transport.start();
        return () => {
          mounted = false;
          transport.close();
          if (transportRef.current === transport) transportRef.current = null;
          for (const objectUrl of frameMetaRef.current.keys()) URL.revokeObjectURL(objectUrl);
          frameMetaRef.current.clear();
          if (shotUrlRef.current) URL.revokeObjectURL(shotUrlRef.current);
          shotUrlRef.current = '';
        };
      }, [scopeEpoch, ready, visible]);

      // 状态同步与帧流解耦：静止页面没有新帧时，地址/运行态仍按固定间隔刷新。
      React.useEffect(() => {
        if (!visible || !ready) return undefined;
        const scopeNow = scopeRef.current;
        const controller = new AbortController();
        let cancelled = false;
        let timer = 0;
        async function tick() {
          // Capture the action generation per request, not per effect: a navigation action bumps
          // the generation and must not stop this poller from rescheduling (only stale responses
          // are dropped).
          const generation = requestGenerationRef.current;
          try {
            const state = await getHost('/state', scopeNow, controller.signal);
            if (!cancelled && generation === requestGenerationRef.current) {
              // The transport needs the (redacted) url before the adopted seed context is published,
              // otherwise a URL change would key one seed request under the previous page.
              if (transportRef.current) transportRef.current.noteState({ url: state.url });
              ingestHostState(state);
            }
          } catch (error) {
            if (cancelled || (error && error.name === 'AbortError')) return;
            const code = error && error.code ? String(error.code) : '';
            // A binding whose entry was evicted (idle close) must be re-resolved, not reused.
            if (scopeNow.kind === 'recent' && scopeNow.binding && /SCOPE_NOT_FOUND|BINDING/i.test(code)) {
              discardBinding(scopeNow.binding);
            }
          }
          if (!cancelled) timer = window.setTimeout(tick, 500);
        }
        tick();
        return () => { cancelled = true; window.clearTimeout(timer); controller.abort(); };
      }, [scopeEpoch, ready, visible]);

      // 性能观测：FPS 与延迟都来自实际显示（img.onload + rAF），不是轮询间隔。
      React.useEffect(() => {
        if (!visible || !ready) return undefined;
        const scopeNow = scopeRef.current;
        const controller = new AbortController();
        let computeTimer = 0;
        let postTimer = 0;
        const compute = () => {
          const now = performance.now();
          displayTimes.current = displayTimes.current.filter((at) => now - at <= 1000);
          const currentFps = displayTimes.current.length;
          let latency = 0;
          if (displayLatencies.current.length > 0) {
            const sorted = [...displayLatencies.current].sort((a, b) => a - b);
            latency = Math.round(sorted[Math.floor(sorted.length / 2)]);
          }
          setFps((previous) => (previous === currentFps ? previous : currentFps));
          setFrameMs((previous) => (previous === latency ? previous : latency));
          perfRef.current = { fps: currentFps, frameMs: latency };
        };
        const post = () => {
          const transport = transportRef.current;
          if (!transport) return;
          const stats = transport.stats();
          fetch(HOST_BASE + '/metrics', {
            method: 'POST',
            headers: Object.assign({ 'content-type': 'application/json' }, scopeHeaders(scopeNow)),
            credentials: 'same-origin',
            signal: controller.signal,
            body: JSON.stringify({
              transport: stats.transport,
              displayFps: perfRef.current.fps,
              endToEndMs: perfRef.current.frameMs,
              transportMs: stats.transportMs,
              droppedClient: stats.droppedClient,
              received: stats.received,
              displayed: displayedRef.current,
              seq: stats.lastSeq,
              epoch: stats.lastEpoch,
              annotationPanelId: annotPublisherRef.current ? annotPublisherRef.current.panelId : null,
              annotationClientRevision: annotPublisherRef.current
                ? (annotPublisherRef.current.ackedClientRevision || null) : null,
              documentKey: annotPublisherRef.current && annotGateRef.current.open
                && annotGateRef.current.context ? annotGateRef.current.context.documentKey : null,
              measured: true,
              measuredAt: Date.now(),
            }),
          }).catch(() => {});
        };
        computeTimer = window.setInterval(compute, 500);
        postTimer = window.setInterval(post, 2000);
        return () => { window.clearInterval(computeTimer); window.clearInterval(postTimer); controller.abort(); };
      }, [scopeEpoch, ready, visible]);

      function onFrameLoad(event) {
        const image = event.currentTarget;
        const source = image.currentSrc || image.src;
        // A duplicate load event for the same object URL must not replace the geometry with a
        // missing-meta sample (the meta entry is consumed by the first load).
        if (frameGeomRef.current && frameGeomRef.current.src === source) return;
        const meta = frameMetaRef.current.get(source);
        // A new document epoch invalidates the drawing; an ordinary frame refresh (same epoch) must
        // keep both committed shapes and the active gesture (docs/viewport-control.md). A seed PNG
        // is not a document transition. `seq`/`ui.revision` are deliberately not used here.
        if (meta && meta.seed !== true && meta.epoch !== undefined && meta.epoch !== null
          && Number.isFinite(Number(meta.epoch))) {
          const epoch = Number(meta.epoch);
          if (annotEpochRef.current !== null && epoch !== annotEpochRef.current) {
            // A new document epoch: retract locally only; the Host document was rotated/cleared.
            annotDropLocalView({ exit: false, discard: true });
          }
          annotEpochRef.current = epoch;
        }
        // The mapping and the barriers read the *displayed* frame: decoded natural* plus the
        // capture-time CSS page size and top-level scroll (docs/viewport-control.md).
        const scroll = frameScrollOf(meta, null);
        const seed = Boolean(meta && meta.seed === true);
        frameGeomRef.current = {
          src: source,
          naturalW: Number(image.naturalWidth) || 0,
          naturalH: Number(image.naturalHeight) || 0,
          pageWidth: meta ? Number(meta.pageWidth) : NaN,
          pageHeight: meta ? Number(meta.pageHeight) : NaN,
          scrollX: scroll.x,
          scrollY: scroll.y,
          // A seed PNG is already composited at its capture C (no client translation); these facts
          // prove it still matches the live canvas before pointer/wheel input is allowed.
          seed,
          seedComposite: seed ? meta.seedComposite === true : false,
          seedCanvasX: seed ? finiteOrNull(meta.seedCanvasX) : null,
          seedCanvasY: seed ? finiteOrNull(meta.seedCanvasY) : null,
          seedScrollX: seed ? finiteOrNull(meta.seedScrollX) : null,
          seedScrollY: seed ? finiteOrNull(meta.seedScrollY) : null,
          seedViewRevision: seed ? finiteOrNull(meta.seedViewRevision) : null,
          seedScale: seed ? finiteOrNull(meta.seedScale) : null,
          seedWidth: seed ? finiteOrNull(meta.seedWidth) : null,
          seedHeight: seed ? finiteOrNull(meta.seedHeight) : null,
          seedContentWidth: seed ? finiteOrNull(meta.seedContentWidth) : null,
          seedContentHeight: seed ? finiteOrNull(meta.seedContentHeight) : null,
          at: Date.now(),
        };
        // The frame's own displacement is computed from the ref above: re-render once it is known.
        setFrameVersion((value) => value + 1);
        // A newly displayed frame may be exactly the mismatching evidence; check whether the canvas
        // barrier now needs a composed seed (or is satisfied).
        scheduleSeedRefreshCheck();
        if (!meta) return;
        frameMetaRef.current.delete(source);
        window.requestAnimationFrame(() => {
          if (meta.seed) return;
          displayTimes.current.push(performance.now());
          const latency = Number(meta.capturedAtMs) > 0 ? Date.now() - Number(meta.capturedAtMs) : -1;
          if (latency >= 0 && latency < 10000) {
            displayLatencies.current.push(latency);
            if (displayLatencies.current.length > 60) displayLatencies.current.shift();
          }
          displayedRef.current += 1;
        });
      }

      // Native, non-passive wheel listeners: React's root `wheel` listener is passive, so a
      // `preventDefault()` there cannot stop the host page/number input from scrolling or
      // stepping. Both handlers are re-read from refs so a listener installed once never goes stale.
      React.useEffect(() => {
        const node = stage.current;
        if (!node || typeof node.addEventListener !== 'function') return undefined;
        const listener = (event) => { if (stageWheelRef.current) stageWheelRef.current(event); };
        node.addEventListener('wheel', listener, { passive: false });
        return () => node.removeEventListener('wheel', listener);
      }, []);
      React.useEffect(() => {
        const node = sizeBarRef.current;
        if (!sizing || !node || typeof node.addEventListener !== 'function') return undefined;
        const listener = (event) => { if (sizeWheelRef.current) sizeWheelRef.current(event); };
        node.addEventListener('wheel', listener, { passive: false });
        return () => node.removeEventListener('wheel', listener);
      }, [sizing]);
      React.useEffect(() => {
        const node = annotBarRef.current;
        if (!annotOn || !node || typeof node.addEventListener !== 'function') return undefined;
        const listener = (event) => { if (annotWidthWheelRef.current) annotWidthWheelRef.current(event); };
        node.addEventListener('wheel', listener, { passive: false });
        return () => node.removeEventListener('wheel', listener);
      }, [annotOn]);

      /**
       * Local feedback for a rejected /input. The click/text is never replayed automatically; a
       * successful Host 200 with no page reaction is a page fact, not a plugin failure.
       */
      function noteInputError(error) {
        if (error && error.name === 'AbortError') return;
        const now = Date.now();
        if (now - inputErrorAtRef.current < 1200) return;
        inputErrorAtRef.current = now;
        const code = String((error && error.code) || '');
        const owner = error && error.payload && error.payload.details && error.payload.details.owner;
        const text = /BUSY|LEASE|OWNER/i.test(code)
          ? 'Agent 正在操作此标签' + (owner ? '（' + String(owner) + '）' : '') + '，输入暂不可用；可切换到其他标签'
          : '输入发送失败，请检查连接后重试';
        setInputNotice(text);
        window.clearTimeout(inputNoticeTimerRef.current);
        inputNoticeTimerRef.current = window.setTimeout(() => setInputNotice(''), 3200);
      }

      /** 面板按键的默认 virtualKeyCode（浏览器给不出 keyCode 时用）。 */
      const PANEL_KEY_CODES = {
        Backspace: 8, Tab: 9, Enter: 13, Shift: 16, Control: 17, Alt: 18, Pause: 19, CapsLock: 20,
        Escape: 27, ' ': 32, PageUp: 33, PageDown: 34, End: 35, Home: 36,
        ArrowLeft: 37, ArrowUp: 38, ArrowRight: 39, ArrowDown: 40, Insert: 45, Delete: 46,
        Meta: 91, ContextMenu: 93,
        F1: 112, F2: 113, F3: 114, F4: 115, F5: 116, F6: 117, F7: 118, F8: 119,
        F9: 120, F10: 121, F11: 122, F12: 123,
      };

      /**
       * 真人按键 → Host `/input` 事件。旧实现有三处漏：`Ctrl/Cmd/Alt` 组合直接 return
       * （快捷键全丢）、只认 7 个键（Home/End/PgUp/PgDn/F1-F12 全丢）、可打印字符走
       * `kind:'text'`（页面收不到 keydown，绑在 keydown 上的快捷键与输入框按键逻辑都看不到）。
       * 现在统一发 keyDown + keyUp：带 modifiers 位掩码、virtualKeyCode、物理 code、autoRepeat，
       * 可打印字符同时带 text/unmodifiedText。
       */
      function panelKeyEvents(event) {
        const key = String((event && event.key) || '');
        if (!key || key === 'Dead' || key === 'Unidentified') return [];
        const modifiers = (event.altKey ? 1 : 0) | (event.ctrlKey ? 2 : 0)
          | (event.metaKey ? 4 : 0) | (event.shiftKey ? 8 : 0);
        const virtualKeyCode = Number.isFinite(event.keyCode) && event.keyCode > 0
          ? event.keyCode
          : PANEL_KEY_CODES[key];
        const printable = key.length === 1;
        // 命令修饰键（Ctrl/Cmd/Alt）按下时这是**快捷键**而不是输入：必须发 rawKeyDown 且不带
        // text——带 text 时 Chrome 按字符插入处理，页面只看到「打了个字母」，全选/复制/粘贴/剪切
        // 这些编辑命令不会执行（用户实测：组合键是分开的、不能真正全选）。
        const altGraph = typeof event.getModifierState === 'function' && event.getModifierState('AltGraph');
        const command = !altGraph && (event.ctrlKey === true || event.metaKey === true || event.altKey === true);
        const text = command ? '' : (printable ? key : (key === 'Enter' ? '\r' : ''));
        const base = {
          kind: 'key',
          key,
          code: event.code || undefined,
          virtualKeyCode,
          modifiers,
          location: Number.isFinite(event.location) ? event.location : undefined,
          autoRepeat: event.repeat === true ? true : undefined,
        };
        const down = Object.assign({}, base, { type: command ? 'rawKeyDown' : 'keyDown' });
        if (text) {
          down.text = text;
          down.unmodifiedText = text;
        }
        // 只发按下。旧实现这里顺手补一个 keyUp（"按下即松开"），于是页面永远看不到"按住"：
        // 游戏里按住 W+A 斜向移动、按住方向键连续走动全部失效（用户实测：WASD 斜向移动没用）。
        // 真实的 keyup 由 onKeyUp 转发，焦点离开预览时由 releasePanelKeys 兜底松开。
        return [down];
      }

      /** 松开：只发 keyUp（与上面的 keyDown 成对，不再凭空补一个）。 */
      function panelKeyReleaseEvents(event) {
        const key = String((event && event.key) || '');
        if (!key || key === 'Dead' || key === 'Unidentified') return [];
        const modifiers = (event.altKey ? 1 : 0) | (event.ctrlKey ? 2 : 0)
          | (event.metaKey ? 4 : 0) | (event.shiftKey ? 8 : 0);
        const virtualKeyCode = Number.isFinite(event.keyCode) && event.keyCode > 0
          ? event.keyCode
          : PANEL_KEY_CODES[key];
        return [{
          kind: 'key',
          type: 'keyUp',
          key,
          code: event.code || undefined,
          virtualKeyCode,
          modifiers,
          location: Number.isFinite(event.location) ? event.location : undefined,
        }];
      }

      /**
       * 焦点离开预览时把"面板以为还按着"的键松开。
       *
       * 少了这一步，用户在预览里按住 W、鼠标点聊天框之后，页面会一直认为 W 还按着（Host 侧现在
       * 也有按键状态表，会把后续事件继续标成 shift/… 位）。只发 keyUp，不产生任何其它副作用。
       */
      function releasePanelKeys() {
        const held = panelHeldKeysRef.current;
        if (!held || !held.size) return;
        const events = [];
        for (const entry of held) {
          events.push({ kind: 'key', type: 'keyUp', key: entry.key, code: entry.code, virtualKeyCode: entry.virtualKeyCode });
        }
        held.clear();
        if (events.length) sendEvents(events);
      }

      /* ---- 系统剪贴板桥：面板里的 Ctrl+C/X/V 与宿主系统共用剪贴板 -------------------------- */
      // 页面跑在宿主的 Chromium 里，它的剪贴板是浏览器内部的；面板（GUI 页面）才有真正的系统
      // 剪贴板 API。所以复制/剪切时把选区文本写进系统剪贴板，粘贴时把系统剪贴板的内容插进页面。
      async function clipboardWriteText(text) {
        const value = String(text || '');
        if (!value) return false;
        try {
          if (navigator.clipboard && typeof navigator.clipboard.writeText === 'function') {
            await navigator.clipboard.writeText(value);
            return true;
          }
        } catch { /* 权限被拒：保持浏览器内部剪贴板行为 */ }
        return false;
      }

      /** 返回 `null` 表示"读不到"（权限/不支持），空串表示"确实是空的"。 */
      async function clipboardReadText() {
        try {
          if (navigator.clipboard && typeof navigator.clipboard.readText === 'function') {
            const text = await navigator.clipboard.readText();
            return typeof text === 'string' ? text : '';
          }
        } catch { /* 权限被拒 */ }
        return null;
      }

      /** 页面当前选区文本（只读评估；输入框/文本域按 selectionStart..End 取，否则取 document 选区）。 */
      function pageSelectionText(signal, scope = scopeRef.current) {
        const expression = "(() => { const el = document.activeElement; "
          + "if (el && (el.tagName === 'INPUT' || el.tagName === 'TEXTAREA')) { const s = el.selectionStart, e = el.selectionEnd; "
          + "return (typeof s === 'number' && typeof e === 'number' && e > s) ? String(el.value).slice(s, e) : ''; } "
          + "return window.getSelection ? String(window.getSelection()) : ''; })()";
        return callHost('eval', { expression }, { scope, signal })
          .then((payload) => {
            if (!payload) return '';
            if (typeof payload.value === 'string') return payload.value;
            if (payload.result && typeof payload.result.value === 'string') return payload.result.value;
            return '';
          })
          .catch(() => '');
      }

      function sendEvents(events, options) {
        const scope = scopeRef.current;
        const epoch = scopeEpochRef.current;
        const documentKey = selectPopDocument();
        const signal = abortRef.current ? abortRef.current.signal : undefined;
        const current = () => epoch === scopeEpochRef.current && documentKey === selectPopDocument()
          && !signal?.aborted && readyRef.current && !writesPausedRef.current
          && !annotRef.current.on && (!pickRef.current.on || options?.wheel === true);
        const pending = inputQueueRef.current.then(async () => {
          if (!current()) return false;
          const prepared = typeof events === 'function' ? await events({ scope, signal }) : events;
          if (!current() || !prepared?.length) return false;
          await callHost('input', { events: prepared }, { scope, signal });
          const clearsNotice = prepared.some((entry) => entry
            && (entry.kind !== 'mouse' || ['mousePressed', 'mouseReleased', 'mouseClicked'].includes(String(entry.type))));
          if (current() && clearsNotice) setInputNotice('');
          return true;
        }).catch((error) => {
          if (current()) noteInputError(error);
          return false;
        });
        inputQueueRef.current = pending;
        return pending;
      }

      // 人类接管：真实输入后 4 秒内标记，其余时间回落到空闲
      const markHuman = () => {
        setMode((current) => (current === 'agent' ? current : 'human'));
        window.clearTimeout(humanTimer.current);
        humanTimer.current = window.setTimeout(() => setMode((current) => (current === 'agent' ? current : 'idle')), 4000);
      };
      React.useEffect(() => () => window.clearTimeout(humanTimer.current), []);

      React.useEffect(() => {
        if (!menu) return;
        const close = (event) => { if (!event.target.closest || !event.target.closest('.utb-more')) setMenu(false); };
        const escape = (event) => { if (event.key === 'Escape') setMenu(false); };
        document.addEventListener('mousedown', close);
        document.addEventListener('keydown', escape);
        return () => { document.removeEventListener('mousedown', close); document.removeEventListener('keydown', escape); };
      }, [menu]);

      // Annotation mode: Delete removes the selection; Esc order is
      // composition → move/marquee cancel → selection clear → editor/draft cancel → exit.
      // Both listeners live only while the mode is on.
      React.useEffect(() => {
        if (!annotOn) return undefined;
        const updateModifiers = (event) => {
          if (!['Shift', 'Alt', 'Control', 'Meta'].includes(event.key)) return;
          const move = annotMoveRef.current;
          const marquee = annotMarqueeRef.current;
          const gesture = move.active ? move : marquee.active ? marquee : null;
          if (!gesture) return;
          const point = move.active ? move.last : marquee.end;
          const map = gesture.map;
          const input = {
            clientX: map.painted.left + (point.x - map.cx) * map.sx,
            clientY: map.painted.top + (point.y - map.cy) * map.sy,
            shiftKey: event.shiftKey, altKey: event.altKey, ctrlKey: event.ctrlKey, metaKey: event.metaKey,
          };
          if (move.active) moveAnnotSelection(input);
          else moveAnnotMarquee(input);
        };
        const onKeyDown = (event) => {
          if (annotComposingRef.current || event.isComposing) return;
          updateModifiers(event);
          const editable = annotEditRef.current.active || pickEditableTarget(event.target)
            || pickEditableTarget(document.activeElement);
          const svg = annotSvgRef.current;
          const canvasFocused = svg && (document.activeElement === svg || svg.contains(document.activeElement));
          const idle = !annotMoveRef.current.active && !annotMarqueeRef.current.active && !annotGestureRef.current.active;
          if (!editable && canvasFocused && idle && !event.altKey) {
            const key = event.key.toLowerCase();
            const command = event.ctrlKey || event.metaKey;
            if ((!command && (key === 'v' || key === 'm'))
              || (command && annotIsSelectionTool(annotRef.current.tool) && (key === 'a' || key === 'd'))) {
              event.preventDefault();
              event.stopPropagation();
              if (command) {
                if (annotIsSelectionTool(annotRef.current.tool)) {
                  if (key === 'a') annotSetSelection(annotShapesRef.current.map((shape) => shape.id), false);
                  else annotClearSelection();
                }
              } else chooseAnnotTool(key === 'v' ? 'select' : 'marquee');
              return;
            }
            const directions = { ArrowLeft: [-1, 0], ArrowRight: [1, 0], ArrowUp: [0, -1], ArrowDown: [0, 1] };
            const direction = directions[event.key];
            if (!command && direction && annotIsSelectionTool(annotRef.current.tool) && annotSelectionRef.current.size) {
              event.preventDefault();
              event.stopPropagation();
              const step = event.shiftKey ? 10 : 1;
              annotShapesRef.current = annotShapesRef.current.map((shape) => annotSelectionRef.current.has(shape.id)
                ? annotTranslateShape(shape, direction[0] * step, direction[1] * step) : shape);
              annotContentSeqRef.current += 1;
              annotDirtyRef.current = true;
              annotPublishSchedule();
              annotSelectionScheduleRender();
              return;
            }
          }
          if (event.key === 'Delete' || event.key === 'Backspace') {
            // 输入框/可编辑区里的 Backspace 属于编辑，不劫持；没有选中时不消费按键。
            if (annotEditRef.current.active || pickEditableTarget(event.target)
              || pickEditableTarget(document.activeElement)) return;
            if (!annotSelectionRef.current.size) return;
            event.preventDefault();
            event.stopPropagation();
            annotDeleteSelection();
            return;
          }
          if (event.key !== 'Escape') return;
          if (annotEditRef.current.active) {
            event.preventDefault();
            cancelAnnotText();
            return;
          }
          if (annotMoveRef.current.active) {
            event.preventDefault();
            cancelAnnotMove();
            return;
          }
          if (annotMarqueeRef.current.active) {
            event.preventDefault();
            cancelAnnotMarquee();
            return;
          }
          if (annotEraseRef.current.active) {
            // 擦掉的对象不回滚；这里只结束手势，不退出模式（§11.4）。
            event.preventDefault();
            finishAnnotErase();
            return;
          }
          if (annotGestureRef.current.active) {
            event.preventDefault();
            cancelAnnotDraft();
            return;
          }
          if (annotSelectionRef.current.size) {
            // 选择不是持久状态：第一下 Esc 只取消选择，再按才退出模式。
            event.preventDefault();
            annotClearSelection();
            return;
          }
          event.preventDefault();
          exitAnnotMode();
          const button = annotButtonRef.current;
          if (button) { try { button.focus({ preventScroll: true }); } catch { /* ignore */ } }
        };
        document.addEventListener('keydown', onKeyDown, true);
        document.addEventListener('keyup', updateModifiers, true);
        return () => {
          document.removeEventListener('keydown', onKeyDown, true);
          document.removeEventListener('keyup', updateModifiers, true);
        };
      }, [annotOn]);

      // A stage scroll changes the painted rect without a React render: an active gesture/edit must
      // not keep drawing against a stale screen mapping.
      React.useEffect(() => {
        const node = stage.current;
        if (!node || typeof node.addEventListener !== 'function') return undefined;
        const onScroll = () => {
          if (!annotRef.current.on) return;
          if (annotGestureRef.current.active || annotEditRef.current.active
            || annotMoveRef.current.active || annotMarqueeRef.current.active) {
            cancelAnnotDraft();
            cancelAnnotMove();
            cancelAnnotMarquee();
            cancelAnnotText();
          }
        };
        node.addEventListener('scroll', onScroll, { passive: true });
        return () => node.removeEventListener('scroll', onScroll);
      }, []);

      /** Adopt a navigation response snapshot; a newer edit made while it was in flight wins. */
      function finishNavigation(state, submittedVersion) {
        if (state) acceptRemote(state);
        if (submittedVersion !== undefined && submittedVersion !== editVersionRef.current) {
          // The user typed a new address while this submit was running: keep that draft.
          pendingRef.current = { active: false };
          setPending(false);
          return;
        }
        if (pendingRef.current.active) {
          pendingRef.current = { active: false };
          setPending(false);
        }
        syncDraft();
      }

      function submit(event, overrideAddress) {
        if (event) event.preventDefault();
        if (annotRef.current.on) return; // annotation mode: local navigation is disabled
        if (pendingRef.current.active) return;
        if (writesPausedRef.current) {
          console.warn('ui-testing: navigation paused while the main view is loading or ambiguous');
          return;
        }
        // A local navigation initiated outside the mode invalidates the drawing immediately and
        // submits a normal empty document under the old identity (§12.1).
        annotNavigationClear();
        // `overrideAddress` lets the history dropdown navigate a stored URL without waiting for a
        // React state round-trip through the draft (the go button and Enter pass the draft).
        const source = typeof overrideAddress === 'string' ? overrideAddress : draft;
        let parsed;
        try {
          const raw = source.trim();
          if (!raw) throw new Error('请输入网址。');
          parsed = new URL(/^[a-z][a-z\d+.-]*:\/\//i.test(raw) ? raw : 'https://' + raw);
          if (parsed.protocol !== 'http:' && parsed.protocol !== 'https:') throw new Error('仅支持 HTTP 和 HTTPS 网址。');
          if (parsed.origin === window.location.origin || parsed.href.replace(/^[a-z][a-z\d+.-]*:\/\//i, '').split('/')[0].includes('@')) throw new Error('不支持应用自身地址或包含凭据的网址。');
        } catch (err) {
          setError((err && err.message) || '请输入有效网址。');
          return;
        }
        const version = editVersionRef.current + 1;
        editVersionRef.current = version;
        pendingRef.current = { active: true, editVersion: version, address: parsed.href };
        dirtyRef.current = false;
        setPending(true);
        setDraft(parsed.href);
        setError('');
        setActivity('正在加载 ' + parsed.host);
        requestGenerationRef.current += 1;
        const generation = requestGenerationRef.current;
        const signal = abortRef.current ? abortRef.current.signal : undefined;
        let scopeNow = scopeRef.current;
        const needsBinding = scopeNow.kind === 'recent' && !scopeNow.binding && !scopeNow.legacy;
        const ensure = needsBinding
          ? callHost('ensure', {}, { scope: scopeNow, signal }).then((payload) => {
              // A real operation on recent must return the binding used by the rest of the chain.
              if (generation !== requestGenerationRef.current) return payload;
              const ensuredState = payload && payload.state ? payload.state : payload;
              const runtimeId = runtimeIdOf(payload) || runtimeIdOf(ensuredState);
              if (runtimeId && hasScopeEvidence(payload)) {
                scopeNow = scopeSnapshot('recent', '', runtimeId, false);
                adoptBinding(runtimeId);
              } else if (!hasScopeEvidence(payload)) {
                markLegacyHost();
              } else {
                throw new Error('运行时不可用');
              }
              return payload;
            })
          : callHost('ensure', {}, { scope: scopeNow, signal });
        ensure
          .then((payload) => {
            // A Host with a shared view is authoritative: navigation must not re-apply this
            // panel's local 393×852. Only an old Host (no ui.view) keeps the legacy write.
            const sharedView = viewOf(payload && payload.state ? payload.state : payload)
              || viewOf(payload);
            if (sharedView) return null;
            return callHost('viewport', { width: pageSize.w, height: pageSize.h }, { scope: scopeNow, signal });
          })
          .then(() => callHost('navigate', { url: parsed.href }, { scope: scopeNow, signal }))
          .then((payload) => {
            // A newer action superseded this submit: its response must not touch loading/error.
            if (generation !== requestGenerationRef.current) return;
            noteHostScope(payload && payload.state);
            noteLegacyHost(payload && payload.state);
            finishNavigation(payload && payload.state, version);
          })
          .catch((err) => {
            if (generation !== requestGenerationRef.current) return;
            if (err && err.name === 'AbortError') return;
            pendingRef.current = { active: false };
            setPending(false);
            dirtyRef.current = true; // keep the failed input until edit / Escape / blur
            setError((err && err.message) || '运行时不可用');
          });
      }

      function reload() {
        if (annotRef.current.on) return; // annotation mode: local navigation is disabled
        if (reloadDisabled || writesPausedRef.current || !readyRef.current) return;
        annotNavigationClear();
        cancelDraft();
        setError('');
        setNavBusy(true);
        setActivity(host ? '正在重新加载 ' + host : '正在重新加载');
        requestGenerationRef.current += 1;
        const generation = requestGenerationRef.current;
        const scopeNow = scopeRef.current;
        const signal = abortRef.current ? abortRef.current.signal : undefined;
        callHost('reload', {}, { scope: scopeNow, signal })
          .then((payload) => {
            if (generation !== requestGenerationRef.current) return;
            setNavBusy(false);
            noteHostScope(payload && payload.state);
            noteLegacyHost(payload && payload.state);
            finishNavigation(payload && payload.state);
          })
          .catch((err) => {
            if (generation !== requestGenerationRef.current) return;
            if (err && err.name === 'AbortError') return;
            setNavBusy(false);
            setError((err && err.message) || '运行时不可用');
          });
      }

      function move(direction) {
        if (annotRef.current.on) return; // annotation mode: local navigation is disabled
        const disabled = direction === 'back' ? backDisabled : forwardDisabled;
        if (disabled || writesPausedRef.current || !readyRef.current) return;
        annotNavigationClear();
        cancelDraft();
        setError('');
        setNavBusy(true);
        setActivity(direction === 'back' ? '正在后退' : '正在前进');
        requestGenerationRef.current += 1;
        const generation = requestGenerationRef.current;
        const scopeNow = scopeRef.current;
        const signal = abortRef.current ? abortRef.current.signal : undefined;
        callHost('history', { direction }, { scope: scopeNow, signal })
          .then((payload) => {
            if (generation !== requestGenerationRef.current) return;
            setNavBusy(false);
            noteHostScope(payload && payload.state);
            noteLegacyHost(payload && payload.state);
            finishNavigation(payload && payload.state);
          })
          .catch((err) => {
            if (generation !== requestGenerationRef.current) return;
            if (err && err.name === 'AbortError') return;
            setNavBusy(false);
            setError((err && err.message) || '运行时不可用');
          });
      }

      // The Host view (when shared) is the display truth; local drafts only feed a legacy Host and
      // the in-progress edit. `fit` stays a local preference: the box always renders W×scale,
      // including while the size bar is collapsed (contract §4.3).
      const viewSync = Boolean(viewRef.current);
      const displaySize = acceptedViewSize();
      const w = displaySize.w;
      const ht = displaySize.h;
      const fitScale = fitScaleValue();
      const manualPercent = clampNumber(Number(zoom) || 100, VIEW_LIMITS.scalePercent[0], VIEW_LIMITS.scalePercent[1]);
      const scale = fit ? fitScale : manualPercent / 100;
      // P0-C v2 preview compositing (docs/viewport-control.md): the W*scale × H*scale box is the
      // clipping viewport. The live frame is translated by the Host's retained residual
      // O = C - S (the same accepted projection that owns canvasInfo), never by
      // (C - frame.scroll): F belongs to the barrier/provenance, and mixing a new S with an old F
      // while a page wheel scrolls produces a transient extra shift / exposed blank band (A2).
      // T = -O * paintedScale. O=0 gives T=0 and keeps the old pixels; a seed is already composed
      // at C and must not be shifted again (T=0).
      const canvasOn = Boolean(canvasInfo && viewRef.current);
      const pickRunning = Boolean(remote && remote.running === true);
      const frameGeom = frameGeomRef.current;
      let frameShiftX = 0;
      let frameShiftY = 0;
      if (canvasOn && frameGeom && !frameGeom.seed
        && frameGeom.naturalW > 0 && frameGeom.naturalH > 0 && w > 0 && ht > 0) {
        const view = viewRef.current;
        const offsetX = finiteOrNull(canvasInfo.offsetX) !== null
          ? Number(canvasInfo.offsetX)
          : (view && finiteOrNull(view.canvasX) !== null && finiteOrNull(view.x) !== null
            ? Number(view.canvasX) - Number(view.x) : null);
        const offsetY = finiteOrNull(canvasInfo.offsetY) !== null
          ? Number(canvasInfo.offsetY)
          : (view && finiteOrNull(view.canvasY) !== null && finiteOrNull(view.y) !== null
            ? Number(view.canvasY) - Number(view.y) : null);
        if (offsetX !== null && offsetY !== null) {
          const k = Math.min((w * scale) / frameGeom.naturalW, (ht * scale) / frameGeom.naturalH);
          const displayScaleX = (frameGeom.naturalW * k) / w;
          const displayScaleY = (frameGeom.naturalH * k) / ht;
          frameShiftX = -offsetX * displayScaleX;
          frameShiftY = -offsetY * displayScaleY;
        }
      }
      const frameShift = Boolean(frameShiftX || frameShiftY);
      // A composed seed is a full white-blank image: clip it to the content intersection so the
      // panel checkerboard (not the Host's evidence white) shows where the canvas is empty. O=0
      // keeps the full image, preserving the old pixels.
      let seedClip = null;
      if (canvasOn && frameGeom && frameGeom.seed && frameGeom.seedComposite) {
        const sw = finiteOrNull(frameGeom.seedWidth);
        const sh = finiteOrNull(frameGeom.seedHeight);
        const sx = finiteOrNull(frameGeom.seedScrollX);
        const sy = finiteOrNull(frameGeom.seedScrollY);
        const scx = finiteOrNull(frameGeom.seedCanvasX);
        const scy = finiteOrNull(frameGeom.seedCanvasY);
        const scw = finiteOrNull(frameGeom.seedContentWidth);
        const sch = finiteOrNull(frameGeom.seedContentHeight);
        const offsetAtCapture = sx !== null && sy !== null && scx !== null && scy !== null
          && (Math.abs(scx - sx) > 0.5 || Math.abs(scy - sy) > 0.5);
        if (offsetAtCapture && sw > 0 && sh > 0 && scw !== null && sch !== null) {
          const clamp = (value, min, max) => Math.min(max, Math.max(min, value));
          const left = clamp(-scx, 0, sw);
          const right = clamp(scx + sw - scw, 0, sw);
          const top = clamp(-scy, 0, sh);
          const bottom = clamp(scy + sh - sch, 0, sh);
          if (left > 0 || right > 0 || top > 0 || bottom > 0) {
            seedClip = `inset(${(top / sh) * 100}% ${(right / sw) * 100}% ${(bottom / sh) * 100}% ${(left / sw) * 100}%)`;
          }
        }
      }
      const canvasBarrierState = canvasOn ? canvasBarrier() : null;
      const canvasInputReady = Boolean(canvasBarrierState && canvasBarrierState.ready);
      // Visible sync state is a pure local projection: a sustained barrier mismatch shows after
      // 650ms (the same bound as the bounded seed retry), recovery clears it immediately.
      React.useEffect(() => {
        if (!canvasOn) {
          mismatchSinceRef.current = 0;
          setSyncMismatch(false);
          return undefined;
        }
        if (canvasInputReady) {
          mismatchSinceRef.current = 0;
          setSyncMismatch(false);
          return undefined;
        }
        if (!mismatchSinceRef.current) mismatchSinceRef.current = Date.now();
        const remaining = Math.max(0, SEED_STALE_MS - (Date.now() - mismatchSinceRef.current));
        const timer = window.setTimeout(() => setSyncMismatch(true), remaining);
        return () => window.clearTimeout(timer);
      }, [canvasOn, canvasInputReady]);
      React.useEffect(() => {
        if (canvasInputReady) setSeedStatus(null);
      }, [canvasInputReady]);
      React.useEffect(() => {
        setSeedStatus(null);
        setSyncMismatch(false);
        setBlankHint('');
        setInputNotice('');
        mismatchSinceRef.current = 0;
      }, [scopeEpoch]);
      React.useEffect(() => () => {
        window.clearTimeout(blankHintTimerRef.current);
        window.clearTimeout(inputNoticeTimerRef.current);
      }, []);
      const posRange = canvasOn ? VIEW_LIMITS.canvas : VIEW_LIMITS.scroll;
      // P0-D annotation render facts. The SVG covers the *untranslated* painted rect; the viewBox is
      // the accepted canvas window. Committed geometry stays in canvas CSS px, so C/scale changes
      // move the drawing with the content instead of re-basing it.
      const annotReady = viewSync && canvasOn;
      // 选元素入口状态（数据属性供 GUI 验收读取）：on/ready/annot/sizing/unsupported/cold。
      const pickReadyNow = Boolean(pickRunning && ready && viewSync && canvasOn && !annotOn && !sizing);
      const pickEntryState = pickOn ? 'on'
        : annotOn ? 'annot'
          : sizing ? 'sizing'
            : !pickRunning ? 'cold'
              : pickReadyNow ? 'ready' : 'unsupported';
      const pickEntryTitle = pickOn ? '退出选元素模式（Esc）'
        : annotOn ? '标注模式下不可选元素（先关闭标注）'
          : sizing ? '尺寸调整模式下不可选元素（先关闭尺寸调整）'
            : !pickRunning ? '需先启动内嵌浏览器'
              : !ready ? '运行环境未就绪'
                : !viewSync ? '等待视口同步'
                  : !canvasOn ? '当前宿主不支持画布框选'
                    : '选择元素发送到聊天框（点击画面中的元素，加入聊天框）';
      const pickEntryDisabled = !pickOn && !pickReadyNow;
      const pickBoxRect = pickOn && frameBoxRef.current ? frameBoxRef.current.getBoundingClientRect() : null;
      const pickScreenNow = pickOn && pickOverlay
        ? pickScreenRect(pickOverlay, frameGeometry(), canvasPosition(), acceptedViewSize(), pickBoxRect)
        : null;
      const pickTagNow = pickScreenNow ? pickTagPosition(pickScreenNow, w * scale, ht * scale) : null;
      // 用户 2026-11-03 追加：三选一 panfit 状态（恰好一个 pressed；default = 既非拖拽也非适应窗口）。
      const panfitState = panMode ? 'pan' : fit ? 'fit' : 'default';
      const annotMapNow = canvasOn && shot ? annotMap() : null;
      const annotMapSignatureNow = annotMapSignature(annotMapNow);
      if (!annotPanelIdRef.current) {
        annotPanelIdRef.current = 'utb-annot-' + Math.random().toString(36).slice(2, 10);
      }
      const annotPanelId = annotPanelIdRef.current;
      // Keep the synchronous ref in step with the rendered state (setters update it earlier, so a
      // handler never observes a "next tick" mode/tool change).
      annotRef.current.on = annotOn;
      annotRef.current.tool = annotTool;
      annotRef.current.color = annotColor;
      annotRef.current.width = annotWidth;
      // Same-tick truth for the sizing gate: the rendered state is authoritative, so a stale ref
      // can never block enterAnnotMode while the entry is visibly enabled.
      sizingRef.current = sizing;
      const annotStyleNow = annotStyleFor(annotTool, annotStyleMode);
      annotRef.current.mode = annotStyleMode;
      annotRef.current.fill = annotStyleNow.fill;
      annotRef.current.stroke = annotStyleNow.stroke;
      // v3 同步状态（§12.5）：SVG 属性 + 状态栏 aria-live 提示。旧 Host 没有 annotationContext
      // 时明确 unsupported 并保留绘制能力，绝不声称 Agent 已可见。The identity gate hides the
      // previous scope's list until the new scope's first trusted state arrives.
      const annotGateOpen = annotGateRef.current.open && annotGateRef.current.epoch === scopeEpoch;
      const annotChannel = Boolean(annotContextNow());
      annotChannelRef.current = annotChannel;
      const annotSyncState = !annotChannel ? 'unsupported' : (annotGateOpen ? annotSync.state : 'idle');
      const annotSyncRevision = annotGateOpen && Number.isFinite(Number(annotSync.revision))
        ? Math.max(0, Math.round(Number(annotSync.revision))) : 0;
      const annotStale = annotStaleState;
      const annotNavHint = '标注按工作区保留，导航/刷新会清除当前页面标注';
      const annotSyncText = annotSyncState === 'unsupported'
        ? '标注未同步（宿主无标注通道）'
        : annotSyncState === 'error'
          ? '标注未同步'
          : annotSyncState === 'pending'
            ? '标注同步中…'
            : '';
      const annotSyncTitle = (annotSyncState === 'unsupported'
        ? '标注未同步：当前宿主没有标注上报通道，标注只在本面板可见，Agent 看不到'
        : annotSyncState === 'error'
          ? '标注未同步：最近一次上报失败，Agent 看到的内容可能已过期'
          : annotSyncState === 'pending'
            ? '标注同步中：正在把本次修改上报给宿主'
            : annotStale.stale && annotStale.staleReason === 'panel-unseen'
              ? '标注已保存到工作区，来源面板心跳已过期'
              : '标注已同步给 Agent（只读线索，不构成页面事实）') + '；' + annotNavHint;
      const annotVisibleShapes = annotGateOpen ? annotShapesRef.current : [];
      React.useEffect(() => {
        // The annotation channel came back (or a remount recovered unconfirmed content): publish
        // the remembered dirty document. A clean panel never posts here (§12.1/§12.4).
        if (!annotChannel || !annotGateOpen || !annotDirtyRef.current) return;
        if (annotSyncRef.current.timer) return;
        annotPublishSchedule();
      }, [annotChannel, annotGateOpen]);
      React.useEffect(() => {
        const previous = annotMapSigRef.current;
        annotMapSigRef.current = annotMapSignatureNow;
        if (!annotOn || !previous || annotMapSignatureNow === previous) return;
        // An external view/geometry change cancels the uncommitted draft/edit; committed shapes stay
        // and are re-mapped by the new viewBox (docs/viewport-control.md).
        if (annotGestureRef.current.active || annotEditRef.current.active || annotEraseRef.current.active
          || annotMoveRef.current.active || annotMarqueeRef.current.active) {
          cancelAnnotDraft();
          cancelAnnotText();
          cancelAnnotMove();
          cancelAnnotMarquee();
          resetAnnotErase();
          setAnnotBusy(false);
        }
      }, [annotMapSignatureNow, annotOn]);

      React.useEffect(() => {
        if (!annotOn) return;
        // Running/runtime loss or a vanished canvas capability retracts the local view and exits;
        // unconfirmed content is remembered (not flushed into a capability that is gone).
        if (!running || !canvasOn) {
          annotRetainDirty(false);
          annotDropLocalView({ exit: true });
        }
      }, [annotOn, running, canvasOn]);
      React.useEffect(() => {
        // v3 §12.1/§12.4: a scope/binding transition only retracts this panel's local view. The
        // unconfirmed content was already handed to the module queue by the reset effect; here the
        // gate is reset so the new scope's first trusted state decides what may be shown/published.
        annotRetainDirty(true);
        annotCancelTransient();
        annotUnsubscribePublisher();
        annotPublisherRef.current = null;
        setAnnotText(null);
        resetAnnotErase();
        setAnnotBusy(false);
        annotShapesRef.current = [];
        annotSelectionRef.current = new Set();
        annotCandidateRef.current = null;
        setAnnotVersion((value) => value + 1);
        annotDirtyRef.current = false;
        annotContentSeqRef.current = 0;
        annotShownRevisionRef.current = 0;
        annotSetStale(false, null);
        annotGateRef.current = { epoch: scopeEpoch, open: false, key: '', revision: -1, context: null, d: null, scope: null, view: null };
        annotRef.current.on = false;
        setAnnotOn(false);
        annotSetSyncState('idle');
      }, [scopeEpoch]);
      React.useEffect(() => () => {
        // v3 §12.4: an unmount freezes the old identity, flushes genuinely dirty content through the
        // module queue (it does not depend on this component's setState) and never sends a release.
        if (annotSyncRef.current.timer) {
          window.clearTimeout(annotSyncRef.current.timer);
          annotSyncRef.current.timer = 0;
        }
        annotCancelTransient();
        if (annotDirtyRef.current) {
          const identity = annotIdentityNow({ anyEpoch: true });
          const entry = annotPublisherRef.current;
          if (identity) annotPublisherQueue(identity.entry, annotBuildSnapshot(identity, annotNormalize()));
          else if (entry) {
            const normalized = annotNormalize();
            annotPublisherRemember(entry, {
              shapes: normalized.shapes,
              truncation: normalized.truncation,
              contentSeq: annotContentSeqRef.current,
              dKey: annotGateRef.current.key,
            });
          }
          annotDirtyRef.current = false;
        }
        const entry = annotPublisherRef.current;
        if (entry) entry.activeDKey = '';
        annotUnsubscribePublisher();
        annotPublisherRef.current = null;
      }, []);

      // 选元素模式的同步闸镜像：进入/退出已同步写 ref，这里只处理任何其它状态变化路径。
      React.useEffect(() => {
        pickRef.current.on = pickOn;
      }, [pickOn]);

      // 画布原点 C 变了（页面滚动/平移/视口变化）：旧框的文档坐标不再属于当前窗口，清掉并重取。
      React.useEffect(() => {
        if (!pickOn) return;
        const ref = pickRef.current;
        if (!ref.on) return;
        ref.hoverSeq += 1;
        ref.hoverQueued = false;
        setPickOverlay(null);
        pickScheduleHover();
      }, [pickOn, canvasInfo]);

      // 选元素模式：Esc 退出（输入框/可编辑区内不劫持），焦点还给入口按钮。
      React.useEffect(() => {
        if (!pickOn) return undefined;
        const onKeyDown = (event) => {
          if (event.key !== 'Escape' || event.isComposing) return;
          if (pickEditableTarget(event.target) || pickEditableTarget(document.activeElement)) return;
          event.preventDefault();
          // 不把 Esc 传给 DSH 的弹层/命令面板（它们各自监听 document keydown）。
          event.stopPropagation();
          exitPickMode();
          const button = pickButtonRef.current;
          if (button) {
            try { button.focus({ preventScroll: true }); } catch { /* ignore */ }
          }
        };
        document.addEventListener('keydown', onKeyDown, true);
        return () => document.removeEventListener('keydown', onKeyDown, true);
      }, [pickOn]);

      // 生命周期闸：运行中/就绪/视口/画布/互斥/scope/active tab 任一失效即退出并清框。
      React.useEffect(() => {
        if (!pickOn) return;
        const alive = Boolean(pickRunning && ready && viewSync && canvasOn && !annotOn && !sizing);
        if (!alive) exitPickMode();
      }, [pickOn, pickRunning, ready, viewSync, canvasOn, annotOn, sizing, scopeEpoch, activeViewId]);

      // 导航/换标签/换 scope：悬浮框立即失效（模式本身由上面的生命周期闸决定）。
      React.useEffect(() => {
        if (pickRef.current.on) pickClearOverlay();
      }, [activeViewId, scopeEpoch, remote.url]);

      // 组件卸载：清掉所有选元素定时器，绝不留下后台请求/提示。
      React.useEffect(() => () => {
        window.clearTimeout(pickStatusTimerRef.current);
        const ref = pickRef.current;
        if (ref.timer) window.clearTimeout(ref.timer);
        if (ref.wheelTimer) window.clearTimeout(ref.wheelTimer);
      }, []);
      /** 手动改比例时关闭自动适配并同步共享比例；重新勾选“适应窗口”只恢复本地自动适配。 */
      function changeFit(checked) {
        if (annotRef.current.on) return; // size-bar controls are disabled in annotation mode
        fitRef.current = checked;
        setFit(checked);
        clearZoomIntent();
        resetZoomAnchor();
        if (checked) {
          viewDirtyRef.current.scale = null;
          syncViewDrafts();
          return;
        }
        // Unchecking fit is a display-preference change only: the input falls back to the
        // shared Host ratio (or the local fit ratio on an old Host) without publishing.
        const view = viewRef.current;
        const percent = view
          ? Math.round(clampNumber(Number(view.scale) * 100, VIEW_LIMITS.scalePercent[0], VIEW_LIMITS.scalePercent[1]))
          : Math.round(fitScale * 100);
        viewDirtyRef.current.scale = null;
        setZoom(String(percent));
      }
      /**
       * 用户 2026-11-03 第 4 条：拖拽/适应窗口分页选择器（互斥，最多一个 aria-pressed）。
       * 选拖拽先关 fit（不发布），选适应窗口先退拖拽（保留既有 flush 语义），再各自切换。
       */
      function pressPanMode() {
        if (panModeRef.current) {
          changePanMode(false);
          return;
        }
        if (fitRef.current) changeFit(false);
        changePanMode(true);
      }
      function pressFitMode() {
        if (fitRef.current) {
          changeFit(false);
          return;
        }
        if (panModeRef.current) changePanMode(false);
        changeFit(true);
      }
      /** 用户 2026-11-03 追加：三选一的「默认」——既非拖拽也非适应窗口，只回落共享比例。 */
      function pressPanFitDefault() {
        if (!panModeRef.current && !fitRef.current) return; // already default: no-op
        if (panModeRef.current) changePanMode(false);
        if (fitRef.current) changeFit(false);
      }
      /**
       * 仅 Web 视图的“无头/有头”切换：Host 会关闭共享 Chromium 再按新模式重启（有头=可见窗口+
       * 持久 profile）。切换成功后所有页面都没了：清掉 binding，让面板回到默认空态，需重新打开页面。
       */
      function changeDisplayMode(next) {
        if (next !== 'headless' && next !== 'headed') return;
        if (displaySwitching || next === displayMode || annotRef.current.on) return;
        setDisplaySwitching(true);
        setTabNotice('');
        callHost('display', { mode: next }, { scope: scopeRef.current }).then(() => {
          setDisplaySwitching(false);
          setBindingState({ identityKey, value: '' });
          setActiveViewId('primary');
          showTabNotice(next === 'headed'
            ? '已切换到有头模式：浏览器窗口可见，页面已关闭，请重新打开'
            : '已切换到无头模式：页面已关闭，请重新打开');
        }).catch((error) => {
          setDisplaySwitching(false);
          const code = String((error && error.code) || '');
          showTabNotice(code === 'DISPLAY_UNAVAILABLE'
            ? '有头模式需要图形显示（DISPLAY）'
            : '切换运行模式失败');
        });
      }

      /** 套用某环境的默认尺寸（只发布 width/height；scale 回落到共享比例）。 */
      function applyEnvDefaultSize(next) {
        const target = envDefaultSize(next);
        const dirty = viewDirtyRef.current;
        dirty.width = target.width;
        dirty.height = target.height;
        dirty.scale = null;
        setWidth(String(target.width));
        setHeight(String(target.height));
        queueViewPatch({ width: target.width, height: target.height });
        changePanMode(false);
        changeFit(target.fit);
      }
      /**
       * 用户 2026-11-03 第 3 条 + M4：切换运行环境先提交 Host 会话选择（POST /config/select，
       * 带本面板 scope），成功后才改本地状态；失败保留旧值并显示错误，不静默切换。
       * 未实现环境（!ready）仍不可选，也不会因为选择而启动任何探测。
       */
      /** 环境视图注册表（提前声明：changeEnv 要按它判断"这个环境有没有视图"）。 */
      const ENV_VIEWS = { web: webViewBody };

      function changeEnv(next) {
        if (annotRef.current.on || envBusy) return;
        const option = ENVIRONMENTS.find((item) => item.id === next);
        if (!option) return;
        if (next === env) return;
        if (enabledFromConfig(hostConfig.state.config, next) === false) {
          setEnvNotice('该目标环境还没有启用：请先在设置页打开它的开关');
          return;
        }
        // 视图层没有这个环境：只切换“看哪个视图”（渲染空态），**不写宿主配置**——
        // v1 宿主不接受 planned 环境，提交只会被拒并回滚，没有任何好处。
        if (typeof ENV_VIEWS[next] !== 'function') {
          setEnvNotice('');
          setEnv(next);
          return;
        }
        if (!option.ready) return;
        const config = hostConfig.state;
        if (config.revision === null) {
          setEnvNotice(config.loading
            ? '正在读取宿主配置，请稍后重试'
            : (config.error || '宿主未提供配置接口，无法切换运行环境'));
          return;
        }
        setEnvBusy(true);
        setEnvNotice('');
        selectHostEnvironment(next, config.revision, scopeRef.current).then((payload) => {
          hostConfig.adopt(payload);
          setEnvBusy(false);
          setEnv(next);
          applyEnvDefaultSize(next);
        }).catch((error) => {
          setEnvBusy(false);
          if (error && error.code === 'CONFIG_CONFLICT') {
            adoptHostConflict(hostConfig, error);
            setEnvNotice('配置已被其他窗口修改（CONFIG_CONFLICT），已刷新；本次切换未生效');
            return;
          }
          setEnvNotice('切换运行环境失败：' + (configErrorText(error && error.message) || '未知错误'));
        });
      }
      /**
       * 用户 2026-11-03 第 5/7 条：左侧四个分辨率预设不再只是宽高——点任一预设同时把 X/Y 归零，
       * 并按当前模式处理右侧 `拖拽|适应窗口|默认` 分页选择器（上下文相关，互斥联动）：
       *   - 拖拽中 → 只退出拖拽（fit 本就是 false），右侧落到「默认」；
       *   - 适应窗口中 → **保持**「适应窗口」（fit 是本地显示偏好，不发布比例；新尺寸自动适应）；
       *   - 已是「默认」→ 仍是「默认」。
       * 不改 `scale`/`%`（「默认」语义 = `%` 回落到共享 view.scale）。
       *
       * 宽高与坐标合并进同一个 120ms 的 v1 patch（一次 /viewport，带 expectedRevision）：画布
       * Host 写 `canvasX/canvasY`，无画布但有共享 view 的 Host 写文档滚动 `x/y`，旧 Host（无
       * 共享 view）只写宽高。X/Y 草稿立即显示 0，不等 Host 回显。
       */
      function applySizePreset(preset) {
        if (annotRef.current.on) return; // size-bar controls are disabled in annotation mode
        // 只退出拖拽（会 flush 待发平移写入，其 x/y 随后被本 patch 的 0 覆盖）；绝不关闭
        // 「适应窗口」——它是本地显示偏好，用户从适应窗口点预设应继续适应新尺寸。
        if (panModeRef.current) changePanMode(false);
        changeSizeField('width', String(preset.w));
        changeSizeField('height', String(preset.h));
        if (!viewRef.current) return; // old Host: only width/height are writable
        changePositionField('x', '0');
        changePositionField('y', '0');
        // changePositionField 只改草稿（与输入框一致）；归零必须搭同一合并 patch 提交。
        queueViewPatch({ x: 0, y: 0 });
      }
      function changeZoom(value) {
        changeScaleField(value);
      }
      function commitZoom() {
        commitViewField('scale');
      }
      stageWheelRef.current = onStageWheel;
      sizeWheelRef.current = onSizeWheel;
      annotWidthWheelRef.current = onAnnotWidthWheel;
      const button = (label, children, onClick, disabled, extra) =>
        h('button', Object.assign({ type: 'button', className: 'utb-btn', title: label, 'aria-label': label, onClick, disabled }, extra || {}), children);
      /**
       * 用户 2026-11-03 追加：每个分页选项左侧的固定 8×8 标记位；只有选中项显示绿色小球，
       * 未选中项 visibility:hidden 保留占位（切换时文字不左右跳动）。纯视觉，不参与计算/上报。
       */
      const segDot = (on, group) => h('svg', {
        className: 'utb-seg-dot',
        width: 8,
        height: 8,
        viewBox: '0 0 8 8',
        'aria-hidden': 'true',
        focusable: 'false',
        'data-utb-seg-dot': on ? 'on' : 'off',
        'data-utb-seg-group': group,
        style: { visibility: on ? 'visible' : 'hidden' },
      }, h('circle', { cx: 4, cy: 4, r: 3, fill: '#22c55e' }));
      const annotToolButton = (tool, label) =>
        h('button', {
          type: 'button',
          className: 'utb-btn utb-annot-tool',
          title: label,
          'aria-label': label,
          'data-utb-annot-tool': tool,
          'aria-pressed': annotTool === tool,
          onClick: () => chooseAnnotTool(tool),
        }, h(IconAnnotTool, { tool }));

      // Status priority: a failed seed is more actionable than the generic syncing hint; an input
      // rejection is more urgent than the one-shot blank hint. All are panel-local.
      const syncNotice = (() => {
        if (seedStatus) return { kind: 'seed-failed', text: '画面未同步，请重试同步或重新加载页面', retry: true, reason: seedStatus.reason };
        if (canvasOn && syncMismatch) return { kind: 'syncing', text: '画面同步中，暂时无法操作', retry: true, reason: canvasBarrierState ? canvasBarrierState.reason : '' };
        if (inputNotice) return { kind: 'input-error', text: inputNotice, retry: false, reason: '' };
        if (blankHint) return { kind: 'blank', text: blankHint, retry: false, reason: '' };
        return null;
      })();
      const tabsSupported = Boolean(stableViews);
      // The strip is a user preference, never a side effect of the tab count: one tab can show
      // the strip (and its `+`) just like many. Hiding the strip only hides the row; the `+`
      // lives inside it, so the toolbar never carries a second new-tab entry.
      const showTabs = tabsSupported && tabsVisible;
      const tabText = (view) => {
        const text = String((view && (view.title || view.hostLabel)) || '新页面').replace(/[\u0000-\u001f\u007f]/gu, '');
        return text.slice(0, 80) || '新页面';
      };
      const POPUP_REASON_TEXT = {
        'no-opener': '无法确认来源', 'no-source': '无法确认来源', 'no-human-input': '需要真人点击',
        'automatic-popup': '自动弹窗已拦截', 'source-stale': '来源已过期', 'target-forbidden': '目标地址不允许',
        'popup-limit': '子页数量已达上限', 'busy': 'Agent 正在操作', 'initialize-failed': '页面初始化失败',
      };
      const activeBusy = Boolean(activeView && activeView.busy);
      const latestPopupNotice = stableViews && Array.isArray(stableViews.popupNotices) && stableViews.popupNotices.length
        ? stableViews.popupNotices[stableViews.popupNotices.length - 1] : null;
      function retrySync() {
        if (remoteRef.current?.running !== true) return;
        const transport = transportRef.current;
        if (!transport || typeof transport.retrySeedRefresh !== 'function') return;
        try { transport.retrySeedRefresh(seedContext()); } catch { /* transport must not break UI */ }
      }

      /**
       * 环境视图注册表：右上角组合框选哪个目标环境，下面就渲染哪个视图。
       * 目前只有 web 实现了视图；其余目标环境在表里缺席 → 走「视图层暂不支持」占位。
       * 接新环境时只加一项（或改成按宿主适配器声明注册），外壳不用动。
       */
      function webViewBody() {
        return [
h('div', { className: 'utb-bar' },
          button('后退', h(IconArrow, { dir: 'back' }), () => move('back'), backDisabled),
          button('前进', h(IconArrow, { dir: 'forward' }), () => move('forward'), forwardDisabled),
          button('刷新', h(IconReload, null), reload, reloadDisabled),
          h('form', { onSubmit: submit, style: { flex: '1 1 auto', minWidth: 0, display: 'flex', position: 'relative' } },
            h('div', { className: 'utb-addr-wrap' },
              h('input', { className: 'utb-addr', type: 'text', value: draft, spellCheck: false, 'aria-label': '网址', placeholder: '输入网址，例如 https://example.com', 'aria-invalid': error ? 'true' : undefined, 'data-invalid': error ? 'true' : 'false', title: error || undefined, disabled: annotOn, onChange: changeAddress, onFocus: () => { focusedRef.current = true; dirtyRef.current = false; }, onBlur: blurAddress, onKeyDown: keyAddress }),
              h('button', {
                type: 'button',
                className: 'utb-addr-hist',
                'aria-label': '最近访问的网址',
                'aria-haspopup': 'menu',
                'aria-expanded': historyOpen,
                title: addressHistory.length
                  ? '最近访问（最多 7 条，最近的在上面）'
                  : '还没有访问记录：先在地址栏打开一个网址',
                'data-utb-history-toggle': historyOpen ? 'open' : 'closed',
                'data-utb-history-count': String(addressHistory.length),
                disabled: annotOn,
                onMouseDown: (event) => event.preventDefault(), // keep the address caret/draft untouched
                onClick: () => setHistoryOpen((value) => !value),
              }, h(IconHistory, null)),
              historyOpen && h('div', {
                className: 'utb-pop utb-addr-pop',
                role: 'menu',
                'aria-label': '最近访问的网址',
                'data-utb-history-list': 'true',
                'data-utb-history-size': String(addressHistory.length),
              },
                h('div', { className: 'utb-addr-pop-head' }, '最近访问（' + addressHistory.length + '/' + ADDRESS_HISTORY_LIMIT + '）'),
                addressHistory.length
                  ? addressHistory.map((url, index) => h('button', {
                    key: url,
                    type: 'button',
                    className: 'utb-menu-item utb-addr-item',
                    role: 'menuitem',
                    title: url,
                    'data-utb-history-item': String(index),
                    'data-utb-history-url': url,
                    onClick: () => chooseHistory(url),
                  }, h('span', { className: 'utb-addr-label' }, addressHistoryLabel(url))))
                  : h('div', { className: 'utb-addr-pop-empty' }, '还没有访问记录')))),
          button('转到', h(IconGo, null), () => submit(undefined), annotOn || busy, {
            'data-utb-go': annotOn || busy ? 'disabled' : 'ready',
            title: '转到地址栏里的网址（等同回车）',
            // Keep the address field focused: a blur would cancel the draft (the input would snap
            // back to the accepted address) before this click could submit what the user typed.
            onMouseDown: (event) => event.preventDefault(),
          }),
          tabsSupported && button('标签页', h('span', { className: 'utb-tabs-glyph', 'aria-hidden': true }, '▤'), () => setTabsVisible((value) => !value), false, {
            'aria-pressed': tabsVisible,
            'data-utb-tabs-toggle': tabsVisible ? 'on' : 'off',
            title: tabsVisible ? '隐藏标签页（页面保持）' : '显示标签页',
          }),
          button('标注', h(IconAnnot, null), toggleAnnotMode, !annotReady || sizing || pickOn, {
            ref: annotButtonRef,
            title: pickOn
              ? '选择元素模式下不可进入标注（先退出选元素）'
              : sizing
                ? '尺寸调整模式下不可进入标注（先关闭尺寸调整）'
                : '标注（标注按工作区保留，导航/刷新会清除当前页面标注）',
            'aria-pressed': annotOn,
            'aria-controls': annotPanelId,
            'data-utb-annot-entry': annotOn ? 'on' : pickOn ? 'pick' : sizing ? 'sizing' : annotReady ? 'ready' : 'unsupported',
            // Closing the mode via this button must cancel an active text edit *before* the
            // focus change blurs the editor (otherwise the blur would submit it).
            onPointerDown: () => {
              if (!annotRef.current.on || !annotEditRef.current.active) return;
              annotEditRef.current.cancel = true;
              annotEditRef.current.active = false;
              setAnnotText(null);
            },
          }),
          button('尺寸调整', h(IconSize, null), toggleSizing, annotOn || pickOn, {
            'aria-pressed': sizing,
            title: pickOn ? '选择元素模式下不可调整尺寸（先退出选元素）' : '尺寸调整',
            'data-utb-size-entry': sizing ? 'on' : pickOn ? 'pick' : 'ready',
          }),
          h('span', { className: 'utb-sr', role: 'alert' }, error || ''),
          button('选择元素发送到聊天框', h(IconInspect, null), togglePickMode, pickEntryDisabled, {
            ref: pickButtonRef,
            title: pickEntryTitle,
            'aria-pressed': pickOn,
            'data-utb-pick-entry': pickEntryState,
          }),
          h('div', { className: 'utb-more' },
            button('更多', h(IconMore, null), () => setMenu((v) => !v), annotOn, { 'aria-expanded': menu, 'aria-haspopup': 'menu' }),
            menu && h('div', { className: 'utb-pop', role: 'menu' },
              h('button', {
                type: 'button',
                className: 'utb-menu-item',
                role: 'menuitem',
                disabled: !devtoolsInfo.enabled,
                title: devtoolsInfo.title,
                'data-utb-devtools': devtoolsInfo.enabled ? 'ready' : 'disabled',
                onClick: openDevtools,
              }, '打开调试工具'),
              openUrl
                ? h('a', { className: 'utb-menu-item', role: 'menuitem', href: openUrl, target: '_blank', rel: 'noopener noreferrer', style: { textDecoration: 'none' }, onClick: () => setMenu(false) }, '在默认浏览器中打开')
                : h('button', { type: 'button', className: 'utb-menu-item', role: 'menuitem', disabled: true }, '在默认浏览器中打开')))),
        showTabs && h('div', {
          className: 'utb-tabs',
          role: 'tablist',
          'aria-label': '浏览器标签页',
          'data-utb-tabs': 'true',
        }, readyViewList.map((view) => h('div', {
          key: view.id,
          id: 'utb-tab-' + view.id,
          className: 'utb-tab',
          role: 'tab',
          'aria-selected': activeView && activeView.id === view.id,
          'aria-label': tabText(view),
          'data-utb-tab': String(view.id),
          tabIndex: activeView && activeView.id === view.id ? 0 : -1,
          title: tabText(view),
          onClick: () => switchView(view.id),
        },
          h('span', { className: 'utb-tab-label' }, tabText(view)),
          h('button', {
            type: 'button',
            className: 'utb-tab-close',
            'aria-label': (view.kind === 'primary' ? '重置标签 ' : '关闭标签 ') + tabText(view),
            title: view.kind === 'primary' ? '关闭标签（回到空态）' : '关闭标签',
            'data-utb-tab-close': String(view.id),
            'data-utb-tab-close-kind': view.kind === 'primary' ? 'primary' : 'popup',
            onClick: (event) => { event.stopPropagation(); closeView(view); },
          }, '×'))),
          h('button', {
            type: 'button',
            className: 'utb-tab-new',
            'data-utb-tab-new': 'strip',
            'aria-label': '新建标签页',
            title: '新建空白标签页',
            disabled: tabOpening,
            onClick: newTab,
          }, '+')),
        tabNotice && h('div', { className: 'utb-sync-note utb-tab-note', role: 'status', 'aria-live': 'polite', 'data-utb-tab-notice': 'true' }, tabNotice),
        selectPop && selectPop.reason && h('div', {
          className: 'utb-sync-note utb-select-note',
          role: 'status',
          'aria-live': 'polite',
          'data-utb-select-unsupported': selectPop.reason,
        }, '该下拉不支持浮层，请用键盘 ↑↓ + Enter'),
        activeBusy && h('div', { className: 'utb-sync-note utb-agent-note', role: 'status', 'aria-live': 'polite', 'data-utb-agent-busy': 'true' }, 'Agent 正在操作此标签；预览继续，输入暂不可用'),
        latestPopupNotice && h('div', {
          className: 'utb-sync-note utb-popup-note',
          role: 'status',
          'aria-live': 'polite',
          'data-utb-popup-notice': String(latestPopupNotice.reason || ''),
          'data-utb-popup-notice-id': String(latestPopupNotice.id || ''),
        }, h('span', null, '已阻止新页面：' + (POPUP_REASON_TEXT[latestPopupNotice.reason] || '来源或目标不允许'))),
        // Local popup-blocked fallback: aria-live text + a real link that loads the same front end.
        // No automatic retry, no Runtime lastError, no claim that DevTools connected.
        devtoolsNotice && h('div', { className: 'utb-devtools-note', role: 'status', 'aria-live': 'polite' },
          h('span', null, devtoolsNotice.message),
          devtoolsNotice.url && h('a', {
            href: devtoolsNotice.url,
            target: '_blank',
            rel: 'noopener noreferrer',
            onClick: () => setDevtoolsNotice(null),
          }, '在新标签页打开调试工具')),
        syncNotice && h('div', {
          className: 'utb-sync-note',
          role: 'status',
          'aria-live': 'polite',
          'data-utb-sync-state': syncNotice.kind,
          'data-utb-sync-reason': String(syncNotice.reason || ''),
        },
          h('span', null, syncNotice.text),
          syncNotice.retry && h('button', {
            type: 'button',
            className: 'utb-sync-retry',
            title: '重新请求画面同步',
            onClick: retrySync,
          }, '重试同步')),
        annotOn && h('div', { className: 'utb-annot-bar', id: annotPanelId, role: 'group', 'aria-label': '标注工具', ref: annotBarRef },
          h('div', { className: 'utb-annot-group', role: 'group', 'aria-label': '标注工具选择' },
            ANNOT_TOOLS.map((tool) => annotToolButton(tool.id, tool.label))),
          h('div', {
            className: 'utb-seg utb-annot-seg',
            role: 'group',
            'aria-label': '填充与外框',
            'data-utb-annot-seg': 'fill-stroke',
          },
            h('button', {
              type: 'button',
              className: 'utb-seg-btn',
              'data-utb-annot-mode': 'fill',
              'aria-label': '填充',
              title: '填充（仅圆形/矩形；当前色不透明）',
              'aria-pressed': annotStyleMode === 'fill',
              disabled: !annotIsClosedTool(annotTool),
              onClick: () => changeAnnotStyleMode('fill'),
            }, segDot(annotStyleMode === 'fill', 'fill-stroke'), '填充'),
            h('button', {
              type: 'button',
              className: 'utb-seg-btn',
              'data-utb-annot-mode': 'stroke',
              'aria-label': '外框',
              title: '外框（仅圆形/矩形；当前色 + 粗细）',
              'aria-pressed': annotStyleMode === 'stroke',
              disabled: !annotIsClosedTool(annotTool),
              onClick: () => changeAnnotStyleMode('stroke'),
            }, segDot(annotStyleMode === 'stroke', 'fill-stroke'), '外框')),
          h('label', { className: 'utb-annot-check', title: '颜色' },
            h('span', null, '颜色'),
            h('input', {
              type: 'color',
              className: 'utb-annot-color',
              value: annotColor,
              'aria-label': '颜色',
              disabled: annotTool === 'eraser' || annotIsSelectionTool(annotTool),
              onChange: (e) => changeAnnotStyle({ color: String(e.target.value || '').toLowerCase() }),
            })),
          h('label', { className: 'utb-annot-check', title: '粗细（1–20 画布 px）' },
            h('span', null, '粗细'),
            h('input', {
              type: 'number',
              className: 'utb-num utb-annot-width',
              min: 1,
              max: 20,
              step: 1,
              value: String(annotWidth),
              'aria-label': '粗细',
              'data-utb-annot-field': 'width',
              disabled: annotTool === 'text' || annotTool === 'eraser' || annotIsSelectionTool(annotTool),
              onChange: (e) => {
                const numeric = Number(e.target.value);
                if (!Number.isFinite(numeric) || String(e.target.value).trim() === '') return;
                changeAnnotStyle({ width: clampNumber(Math.round(numeric), 1, 20) });
              },
            })),
          // v2 §11.4：横栏右侧（粗细之后）的可见文案按钮；仅模式内可见、无二次确认、空态禁用。
          // 「粗细」之后：把当前页面连同标注截成一张图，加入聊天框附件。
          // 禁用条件与「清除画布」同源（没有可视画面 / 正在截图都不派发）。
          h('button', {
            type: 'button',
            className: 'utb-btn utb-annot-shot',
            'aria-label': '截图（含标注）',
            title: '把当前页面连同标注一起截图，加入聊天框附件',
            'data-utb-annot-action': 'capture',
            'data-utb-annot-shot': annotShotBusy ? 'busy' : (annotReady ? 'ready' : 'unsupported'),
            disabled: !annotReady || annotShotBusy,
            onClick: captureAnnotationShot,
          }, annotShotBusy ? '截图中…' : '截图'),
          annotShotNotice && h('span', {
            className: 'utb-annot-sync',
            role: 'status',
            'aria-live': 'polite',
            'data-utb-annot-shot-notice': 'true',
          }, annotShotNotice),
          annotSelectionCount() > 0 && h('button', {
            type: 'button',
            className: 'utb-btn utb-annot-delete',
            'aria-label': '删除选中的标注',
            title: '删除选中的标注（Delete / Backspace）',
            'data-utb-annot-action': 'delete-selection',
            'data-utb-annot-selection': String(annotSelectionCount()),
            disabled: !annotReady,
            onClick: () => annotDeleteSelection(),
          }, '删除选中（' + annotSelectionCount() + '）'),
          h('button', {
            type: 'button',
            className: 'utb-btn utb-annot-clear',
            'aria-label': '清除画布',
            title: '清除画布',
            'data-utb-annot-action': 'clear',
            disabled: !annotReady || (!annotShapesRef.current.length && !annotBusy && !annotText),
            onPointerDown: annotClearPointerDown,
            onClick: clearAnnotCanvas,
          }, '清除画布')),
        sizing && h('div', { className: 'utb-size', ref: sizeBarRef },
          h('div', { className: 'utb-size-left' },
            // 用户 2026-11-03 第 2 轮：左侧四个分辨率预设改为与「填充|外框」「拖拽|适应窗口|默认」
            // 相同的分页选择器（绿色小球选中态）。选中 = 非拖拽且宽高精确匹配（零或一项选中）；
            // 拖拽模式与预设互斥（pan 时四项全部 aria-pressed=false、小球隐藏）。
            h('div', {
              className: 'utb-seg utb-presets',
              role: 'group',
              'aria-label': '分辨率预设',
              'data-utb-preset': '',
            },
              PRESETS.map((preset) => {
                const selected = !panMode && w === preset.w && ht === preset.h;
                return h('button', {
                  key: preset.id,
                  type: 'button',
                  className: 'utb-seg-btn utb-preset',
                  title: `${preset.label} ${preset.w} × ${preset.h}`,
                  'data-utb-preset-opt': preset.id,
                  'aria-label': preset.label,
                  'aria-pressed': selected,
                  disabled: annotOn,
                  onClick: () => applySizePreset(preset),
                }, segDot(selected, 'preset'), preset.label);
              }))),
          h('span', { className: 'utb-gap' }),
          h('div', { className: 'utb-size-right' },
            h('span', { className: 'utb-pos-label', 'aria-hidden': true }, 'X'),
            h('input', {
              className: 'utb-num utb-pos',
              type: 'number',
              min: posRange[0],
              max: posRange[1],
              step: 10,
              value: posX,
              'data-utb-field': 'x',
              'aria-label': '视口 X 坐标（像素）',
              title: canvasOn
                ? '画布坐标 X（画布 CSS px，可为负）；滚轮调整（Shift ×10，Alt ×1），Enter 提交，Esc 恢复'
                : viewSync
                  ? '页面顶层滚动位置 X（文档 CSS px）；滚轮调整（Shift ×10，Alt ×1），Enter 提交，Esc 恢复'
                  : '旧宿主不支持视口坐标同步',
              disabled: !viewSync || annotOn,
              onChange: (e) => changePositionField('x', e.target.value),
              onFocus: () => { viewFocusRef.current = 'x'; },
              onBlur: () => { viewFocusRef.current = ''; commitViewField('x'); },
              onKeyDown: (e) => sizeFieldKey(e, 'x'),
            }),
            h('span', { className: 'utb-pos-label', 'aria-hidden': true }, 'Y'),
            h('input', {
              className: 'utb-num utb-pos',
              type: 'number',
              min: posRange[0],
              max: posRange[1],
              step: 10,
              value: posY,
              'data-utb-field': 'y',
              'aria-label': '视口 Y 坐标（像素）',
              title: canvasOn
                ? '画布坐标 Y（画布 CSS px，可为负）；滚轮调整（Shift ×10，Alt ×1），Enter 提交，Esc 恢复'
                : viewSync
                  ? '页面顶层滚动位置 Y（文档 CSS px）；滚轮调整（Shift ×10，Alt ×1），Enter 提交，Esc 恢复'
                  : '旧宿主不支持视口坐标同步',
              disabled: !viewSync || annotOn,
              onChange: (e) => changePositionField('y', e.target.value),
              onFocus: () => { viewFocusRef.current = 'y'; },
              onBlur: () => { viewFocusRef.current = ''; commitViewField('y'); },
              onKeyDown: (e) => sizeFieldKey(e, 'y'),
            }),
            h('input', {
              className: 'utb-num',
              type: 'number',
              min: VIEW_LIMITS.width[0],
              max: VIEW_LIMITS.width[1],
              value: width,
              'data-utb-field': 'width',
              'aria-label': '视口宽度（像素）',
              title: '视口宽度（200–4096 px）；滚轮调整（Shift ×10，Alt ×1）',
              disabled: annotOn,
              onChange: (e) => changeSizeField('width', e.target.value),
              onFocus: () => { viewFocusRef.current = 'width'; },
              onBlur: () => { viewFocusRef.current = ''; commitViewField('width'); },
              onKeyDown: (e) => sizeFieldKey(e, 'width'),
            }),
            h('span', { 'aria-hidden': true }, '×'),
            h('input', {
              className: 'utb-num',
              type: 'number',
              min: VIEW_LIMITS.height[0],
              max: VIEW_LIMITS.height[1],
              value: height,
              'data-utb-field': 'height',
              'aria-label': '视口高度（像素）',
              title: '视口高度（200–4096 px）；滚轮调整（Shift ×10，Alt ×1）',
              disabled: annotOn,
              onChange: (e) => changeSizeField('height', e.target.value),
              onFocus: () => { viewFocusRef.current = 'height'; },
              onBlur: () => { viewFocusRef.current = ''; commitViewField('height'); },
              onKeyDown: (e) => sizeFieldKey(e, 'height'),
            }),
            h('span', null, 'px'),
            h('div', {
              className: 'utb-seg utb-panfit',
              role: 'group',
              'aria-label': '拖拽与适应',
              'data-utb-panfit': '',
              'data-utb-panfit-state': panfitState,
            },
              h('button', {
                type: 'button',
                className: 'utb-seg-btn',
                'data-utb-panfit-opt': 'pan',
                'aria-label': '拖拽视口',
                title: panMode
                  ? '拖拽视口：按住画面拖动平移页面（内容跟手，X/Y 随之更新）；再点一次关闭并恢复页面交互'
                  : '拖拽视口：点击后按住画面拖动可平移页面（内容跟手，X/Y 随之更新）；关闭后恢复页面交互',
                'aria-pressed': panMode,
                disabled: !viewSync || !canvasOn || annotOn,
                onClick: pressPanMode,
              }, segDot(panMode, 'panfit'), '拖拽'),
              h('button', {
                type: 'button',
                className: 'utb-seg-btn',
                'data-utb-panfit-opt': 'fit',
                'aria-label': '适应窗口',
                title: '适应窗口仅本地显示，不改变共享比例/Agent 截图比例',
                'aria-pressed': fit,
                disabled: annotOn,
                onClick: pressFitMode,
              }, segDot(fit, 'panfit'), '适应窗口'),
              h('button', {
                type: 'button',
                className: 'utb-seg-btn',
                'data-utb-panfit-opt': 'default',
                'aria-label': '默认',
                title: '默认：不拖拽、不自动适应，按共享比例显示（不发布视口）',
                'aria-pressed': !panMode && !fit,
                disabled: annotOn,
                onClick: pressPanFitDefault,
              }, segDot(!panMode && !fit, 'panfit'), '默认')),
            h('input', {
              className: 'utb-num utb-zoom',
              type: 'number',
              min: VIEW_LIMITS.scalePercent[0],
              max: VIEW_LIMITS.scalePercent[1],
              step: 5,
              value: fit ? String(Math.round(fitScale * 100)) : zoom,
              'data-utb-field': 'scale',
              'aria-label': '预览缩放比例（百分比）',
              title: fit
                ? '适应窗口仅本地显示，不改变共享比例/Agent 截图比例'
                : '预览缩放比例（10–200%）；手动修改会关闭适应窗口，并作为共享比例（Agent 截图默认密度）',
              disabled: annotOn,
              onChange: (e) => changeZoom(e.target.value),
              onFocus: () => { viewFocusRef.current = 'scale'; },
              onBlur: () => { viewFocusRef.current = ''; commitZoom(); },
              onKeyDown: (e) => sizeFieldKey(e, 'scale'),
            }),
            h('span', { className: 'utb-dim', 'aria-hidden': true }, '%'))),
        (pickOn || pickStatus) && h('div', {
          className: 'utb-sync-note utb-pick-note',
          role: 'status',
          'aria-live': 'polite',
          'data-utb-pick-status': pickStatus ? pickStatus.kind : 'mode',
        }, pickStatus ? pickStatus.text : '选元素模式：点击画面中的元素加入聊天框 · 滚轮可滚动页面 · Esc 退出'),
        // The whole preview area swallows the host context menu (page clicks only); see
        // onFrameContextMenu. Outside this element the host menu keeps its normal behaviour.
        h('div', { className: 'utb-stage', ref: stage, onContextMenu: onFrameContextMenu },
          activeUrl
            ? (shot
              ? h('div', {
                className: 'utb-box',
                ref: frameBoxRef,
                'data-fitted': fit && scale < 1 ? 'true' : 'false',
                'data-utb-annot': annotOn ? 'on' : 'off',
                // Stable read-only hooks for layout/state assertions when the size bar is closed
                // (the annotation mode and the size bar are mutually exclusive, user 2026-11-03).
                'data-utb-fit': fit ? 'true' : 'false',
                'data-utb-pan-state': panMode ? 'on' : 'off',
                'data-utb-canvas': canvasOn ? 'on' : 'off',
                'data-utb-canvas-ready': canvasOn ? (canvasInputReady ? 'true' : 'false') : 'off',
                'data-utb-canvas-blank': canvasOn ? 'checkerboard' : 'off',
                'data-utb-canvas-zoom': panMode && canvasOn ? 'wheel' : 'off',
                'data-utb-canvas-zoom-anchor': panMode && canvasOn ? zoomAnchor : 'off',
                'data-utb-canvas-zoom-anchor-state': panMode && canvasOn ? zoomAnchorState : 'off',
                'data-utb-view-revision': viewRef.current ? String(Number(viewRef.current.revision)) : '',
                'data-utb-canvas-checker': canvasOn
                  ? `${CANVAS_CHECKER.size}px ${CANVAS_CHECKER.dark} ${CANVAS_CHECKER.light}`
                  : 'off',
                onPointerDown: onBoxPointerDown,
                // Diagnostic reason for the fail-closed barrier (never a page fact).
                'data-utb-canvas-barrier': canvasOn ? String(canvasBarrierState.reason || '') : 'off',
                // Bounded diagnostic numbers for acceptance failures (safe, no page content).
                'data-utb-canvas-detail': canvasOn ? JSON.stringify({
                  reason: canvasBarrierState.reason,
                  frameScrollX: frameGeom ? finiteOrNull(frameGeom.scrollX) : null,
                  frameScrollY: frameGeom ? finiteOrNull(frameGeom.scrollY) : null,
                  sX: observedScroll().x,
                  sY: observedScroll().y,
                  pageW: frameGeom ? frameGeom.pageWidth : null,
                  pageH: frameGeom ? frameGeom.pageHeight : null,
                  naturalW: frameGeom ? frameGeom.naturalW : null,
                  naturalH: frameGeom ? frameGeom.naturalH : null,
                  frameAgeMs: frameGeom && frameGeom.at ? Date.now() - frameGeom.at : null,
                  viewW: w,
                  viewH: ht,
                  seed: Boolean(frameGeom && frameGeom.seed),
                  seedRev: frameGeom ? frameGeom.seedViewRevision : null,
                  viewRev: viewRef.current ? Number(viewRef.current.revision) : null,
                }) : 'off',
                style: {
                  width: w * scale,
                  height: ht * scale,
                  position: 'relative',
                  // Blank paint comes from the CSS checkerboard rule above; with O=0 the frame
                  // covers the box and the old pixels stay identical.
                },
              },
                // Pan-only transparent layer UNDER the frame: it makes the composited blank
                // draggable even when the frame is translated entirely out of the clipping box.
                // Content keeps hitting the <img> (z-index 1) so frame wheel and normal hit-testing
                // are unchanged; the layer exists only while 拖拽 is checked.
                panMode && canvasOn ? h('div', {
                  className: 'utb-pan-layer',
                  'data-utb-pan-layer': 'true',
                  'aria-hidden': true,
                  style: {
                    position: 'absolute', inset: 0, zIndex: 0,
                    cursor: panDragging ? 'grabbing' : 'grab',
                    touchAction: 'none', userSelect: 'none',
                  },
                  onPointerDown: onFramePointerDown,
                  onPointerMove: onFramePointerMove,
                  onPointerUp: onFramePointerUp,
                  onPointerCancel: releaseFrameDrag,
                  onLostPointerCapture: releaseFrameDrag,
                }) : null,
                h('img', {
                  className: 'utb-frame',
                  ref: frameImgRef,
                  src: shot,
                  alt: '内嵌浏览器画面',
                  onLoad: onFrameLoad,
                  tabIndex: 0,
                  draggable: false,
                  'data-utb-pan': panMode ? 'on' : 'off',
                  'data-utb-pan-drag': panDragging ? 'true' : 'false',
                  'data-utb-canvas-seed-clip': seedClip || 'off',
                  style: {
                    display: 'block', width: '100%', height: '100%', objectFit: 'contain', objectPosition: '50% 50%',
                    userSelect: 'none', touchAction: 'none',
                    position: 'relative', zIndex: 1,
                    cursor: pickOn ? 'crosshair' : panMode ? (panDragging ? 'grabbing' : 'grab') : frameCursor,
                    transform: frameShift ? `translate(${frameShiftX}px, ${frameShiftY}px)` : 'none',
                    clipPath: seedClip || undefined,
                  },
                  onPointerDown: onFramePointerDown,
                  onPointerUp: onFramePointerUp,
                  onPointerMove: onFramePointerMove,
                  onPointerCancel: releaseFrameDrag,
                  onLostPointerCapture: releaseFrameDrag,
                  onPointerLeave: () => {
                    if (pickRef.current.on) pickClearOverlay();
                    resetFrameCursor();
                  },
                  onKeyDown: (event) => {
                    if (annotRef.current.on) return; // annotation mode: zero page input
                    if (pickRef.current.on) return; // pick mode: zero page keyboard input
                    if (event.isComposing) return; // IME 组合中：别抢字符
                    if (event.key === 'Escape' && selectPopRef.current?.reason) selectPopClose();
                    const commandKey = event.ctrlKey === true || event.metaKey === true;
                    const keyName = String(event.key || '').toLowerCase();
                    if (commandKey && event.altKey !== true && (keyName === 'c' || keyName === 'x')) {
                      // 复制/剪切：页面照常处理，同时把选区文本写进系统剪贴板（读要在转发前，剪切会删掉选区）。
                      event.preventDefault();
                      const events = panelKeyEvents(event);
                      sendEvents(async ({ scope, signal }) => {
                        const text = await pageSelectionText(signal, scope);
                        if (text) await clipboardWriteText(text);
                        return events;
                      });
                      return;
                    }
                    if (commandKey && event.altKey !== true && keyName === 'v') {
                      // 粘贴：系统剪贴板可读就由我们插入文本，避免浏览器内部剪贴板插入旧内容。
                      event.preventDefault();
                      const events = panelKeyEvents(event);
                      const textRead = clipboardReadText();
                      sendEvents(async () => {
                        const text = await textRead;
                        if (text === null) return events;
                        return text === '' ? [] : [{ kind: 'text', text }];
                      });
                      return;
                    }
                    const events = panelKeyEvents(event);
                    if (!events.length) return;
                    event.preventDefault();
                    // 记下"还按着"的键：真实 keyup 由 onKeyUp 转发，焦点离开时由 onBlur 兜底松开。
                    const identity = event.code || event.key;
                    if (identity && !event.repeat) {
                      panelHeldKeysRef.current.set(identity, {
                        key: String(event.key || ''),
                        code: event.code || undefined,
                        virtualKeyCode: Number.isFinite(event.keyCode) && event.keyCode > 0 ? event.keyCode : undefined,
                      });
                    }
                    sendEvents(events);
                  },
                  // 松开：只转发 keyUp。少这一条时页面永远看不到"按住"，按住 W+A 斜向移动这类
                  // 连续输入全部失效（用户实测）。
                  onKeyUp: (event) => {
                    if (annotRef.current.on) return;
                    if (pickRef.current.on) return;
                    if (event.isComposing) return;
                    const identity = event.code || event.key;
                    if (identity) panelHeldKeysRef.current.delete(identity);
                    const events = panelKeyReleaseEvents(event);
                    if (!events.length) return;
                    event.preventDefault();
                    sendEvents(events);
                  },
                  onBlur: () => { releasePanelKeys(); },
                }),
                // 原生 <select> 的面板侧浮层：绝对定位在画面框内、点击点附近。
                // 浏览器自己的弹层在 UI 图层（帧里看不到），所以选项列表由面板绘制；
                // 写回走 POST /select（与 /input 同一套门禁）。
                selectPop && !selectPop.reason ? (() => {
                  const rowCount = (selectPop.select.options || []).length;
                  const layout = selectPopLayout(selectPop.anchor, rowCount, selectPop.bounds);
                  return h('div', {
                    className: 'utb-select-pop',
                    ref: (node) => {
                      selectPopElementRef.current = node;
                      if (node && node.dataset.utbSelectFocused !== '1') {
                        node.dataset.utbSelectFocused = '1';
                        try { node.focus({ preventScroll: true }); } catch { /* focus 是 best-effort */ }
                      }
                    },
                    role: 'listbox',
                    tabIndex: -1,
                    'aria-label': '下拉选项',
                    'data-utb-select-pop': selectPop.reason || 'ready',
                    'data-utb-select-reason': selectPop.reason || '',
                    'data-utb-select-side': layout.side,
                    'data-utb-select-layout': JSON.stringify({
                      left: layout.left, top: layout.top, width: layout.width,
                      maxHeight: layout.maxHeight, flippedUp: layout.flippedUp, shiftedLeft: layout.shiftedLeft,
                    }),
                    style: {
                      position: 'absolute',
                      left: layout.left,
                      top: layout.top,
                      width: layout.width,
                      maxHeight: layout.maxHeight,
                      zIndex: 6,
                    },
                    onKeyDown: onSelectPopKeyDown,
                  }, (selectPop.select.options || []).map((option, index) => h('div', {
                        key: `${index}:${option.value}`,
                        className: 'utb-select-pop-item',
                        role: 'option',
                        'aria-selected': index === selectPop.activeIndex ? 'true' : 'false',
                        'aria-disabled': option.disabled ? 'true' : 'false',
                        'data-utb-select-item': option.disabled ? 'disabled'
                          : (index === selectPop.activeIndex ? 'active' : 'ready'),
                        'data-utb-select-value': option.value,
                        title: option.label || option.value,
                        // 浮层内的按下不许穿透成页面鼠标事件（否则又是一次 select 点击）。
                        onPointerDown: (event) => { event.preventDefault(); event.stopPropagation(); },
                        onPointerEnter: () => {
                          if (option.disabled) return;
                          setSelectPop((current) => (current && current.seq === selectPop.seq
                            ? Object.assign({}, current, { activeIndex: index })
                            : current));
                        },
                        onClick: () => selectPopChoose(option),
                      }, option.label || option.value || '（空值）')));
                })() : null,
                pageContext ? (() => {
                  const layout = selectPopLayout(pageContext.anchor, pageContext.items.length, pageContext.bounds);
                  return h('div', {
                    className: 'utb-select-pop utb-context-menu',
                    'data-utb-context-menu': 'default',
                    role: 'menu', tabIndex: -1, 'aria-label': '页面右键菜单',
                    'aria-activedescendant': `utb-context-item-${pageContext.seq}-${pageContext.activeIndex}`,
                    ref: node => {
                      pageContextElementRef.current = node;
                      if (node && node.dataset.utbFocused !== '1') {
                        node.dataset.utbFocused = '1';
                        node.focus({ preventScroll: true });
                      }
                    },
                    style: { position: 'absolute', left: layout.left, top: layout.top, width: layout.width, maxHeight: layout.maxHeight, zIndex: 7 },
                    onPointerDown: event => { event.preventDefault(); event.stopPropagation(); },
                    onKeyDown: onPageContextKeyDown,
                  }, pageContext.items.map((item, index) => h('button', {
                    key: item.id, id: `utb-context-item-${pageContext.seq}-${index}`,
                    className: 'utb-select-pop-item', type: 'button', role: 'menuitem', tabIndex: -1,
                    disabled: item.disabled === true, 'aria-disabled': item.disabled ? 'true' : 'false',
                    'data-utb-context-action': item.id,
                    'data-utb-select-item': item.disabled ? 'disabled' : index === pageContext.activeIndex ? 'active' : 'ready',
                    style: { border: 0, textAlign: 'left' },
                    onPointerEnter: () => { if (!item.disabled) setPageContext(current => current ? { ...current, activeIndex: index } : current); },
                    onClick: () => choosePageContext(item),
                  }, item.label)));
                })() : null,
                // P0-D annotation layer: covers the untranslated painted rect, viewBox = accepted
                // canvas window. Committed shapes are React nodes; the live draft is one imperative
                // <g> updated by rAF (never re-rendered per pointer move).
                h('svg', {
                  className: 'utb-annot-layer',
                  ref: annotSvgRef,
                  'data-utb-annot-layer': 'true',
                  'data-utb-annot-space': 'canvas-css-px',
                  'data-utb-annot-sync': annotSyncState,
                  'data-utb-annot-revision': String(annotSyncRevision),
                  'data-utb-annot-active-tool': annotTool,
                  'data-utb-annot-selection-count': String(annotSelectionCount()),
                  role: 'img',
                  'aria-label': '标注画布',
                  tabIndex: annotOn ? 0 : -1,
                  viewBox: annotMapNow
                    ? `${annotMapNow.cx} ${annotMapNow.cy} ${annotMapNow.w} ${annotMapNow.h}`
                    : '0 0 1 1',
                  preserveAspectRatio: 'none',
                  style: {
                    position: 'absolute',
                    left: annotMapNow ? annotMapNow.painted.left - annotMapNow.boxRect.left : 0,
                    top: annotMapNow ? annotMapNow.painted.top - annotMapNow.boxRect.top : 0,
                    width: annotMapNow ? annotMapNow.painted.width : 1,
                    height: annotMapNow ? annotMapNow.painted.height : 1,
                    overflow: 'hidden',
                    zIndex: 2,
                    display: annotMapNow ? 'block' : 'none',
                    pointerEvents: annotOn ? 'auto' : 'none',
                    cursor: annotOn
                      ? (annotMoveRef.current.active && annotMoveRef.current.dragging ? 'grabbing'
                        : annotTool === 'select' || annotTool === 'marquee' ? annotHoverRef.current
                          : annotTool === 'text' ? 'text'
                            : 'crosshair')
                      : 'default',
                    touchAction: 'none',
                    userSelect: 'none',
                  },
                  onPointerDown: onAnnotPointerDown,
                  onPointerMove: onAnnotPointerMove,
                  onPointerUp: onAnnotPointerUp,
                  onPointerCancel: onAnnotPointerCancel,
                  onLostPointerCapture: onAnnotPointerCancel,
                  onPointerLeave: () => annotSetHoverCursor('default'),
                },
                  // 选中光晕先画：同一几何用品牌色加粗描边垫在图形下面，图形本体仍保持原色。
                  annotVisibleShapes.map((shape) => (annotSelectionRef.current.has(shape.id)
                    ? renderAnnotShape(shape, {
                      key: 'annot-halo-' + shape.id,
                      className: 'utb-annot-select-halo',
                      'data-utb-annot-halo': shape.id,
                      'data-utb-annot-state': 'halo',
                      'data-utb-annot-selected': 'true',
                    })
                    : null)),
                  annotVisibleShapes.map((shape) => renderAnnotShape(shape, {
                    'data-utb-annot-selected': annotSelectionRef.current.has(shape.id) ? 'true' : 'false',
                  })),
                  // 选中态：每个选中图形一组「行进蚂蚁」框（白底 + 蓝色虚线 + 蓝色淡填充），
                  // 保证在浅色/深色页面上都能一眼看出；纯面板视觉，不进 Host 截图、不改图形数据。
                  annotVisibleShapes.map((shape) => {
                    if (!annotSelectionRef.current.has(shape.id)) return null;
                    const box = annotShapeBounds(shape);
                    if (!box) return null;
                    const rect = { x: box.x, y: box.y, width: box.w, height: box.h, rx: 2 };
                    return h('g', {
                      key: 'annot-select-' + shape.id,
                      className: 'utb-annot-select-group',
                      'data-utb-annot-select-box': shape.id,
                    },
                      h('rect', Object.assign({}, rect, { className: 'utb-annot-select-fill' })),
                      h('rect', Object.assign({}, rect, { className: 'utb-annot-select-edge' })),
                      h('rect', Object.assign({}, rect, { className: 'utb-annot-select-ants' })));
                  }),
                  annotSelectionCount() > 1 && (() => {
                     const box = annotSelectionBounds();
                     if (!box) return null;
                     const rect = { x: box.x, y: box.y, width: box.w, height: box.h, rx: 2 };
                     return h('g', { key: 'annot-group-bounds', className: 'utb-annot-select-group', 'data-utb-annot-group-box': 'true' },
                       h('rect', Object.assign({}, rect, { className: 'utb-annot-select-edge' })),
                       h('rect', Object.assign({}, rect, { className: 'utb-annot-select-ants' })));
                   })(),
                   h('g', { key: 'annot-draft', 'data-utb-annot-state': 'draft', ref: annotDraftRef })),
                annotText ? h('input', {
                  key: 'annot-text-input-' + annotText.id,
                  className: 'utb-annot-text-input',
                  ref: annotInputRef,
                  type: 'text',
                  maxLength: 200,
                  defaultValue: '',
                  'aria-label': '标注文字',
                  autoFocus: true,
                  style: {
                    left: annotText.left,
                    top: annotText.top,
                    width: 220,
                    height: Math.max(18, annotText.fontSize * 1.4),
                    fontSize: annotText.fontSize,
                    color: annotText.color,
                    borderColor: annotText.color,
                  },
                  onKeyDown: annotTextKey,
                  onBlur: () => commitAnnotText(),
                  onCompositionStart: () => { annotComposingRef.current = true; },
                  onCompositionEnd: () => { annotComposingRef.current = false; },
                }) : null,
                // 选元素悬浮框：纯面板 DOM，pointer-events:none，被 .utb-box 裁剪，不进 Host 截图。
                pickOn ? h('div', {
                  className: 'utb-pick-layer',
                  'data-utb-pick-layer': 'true',
                  'data-utb-pick-state': pickOverlay ? 'hover' : 'idle',
                  'aria-hidden': 'true',
                },
                  pickScreenNow && pickOverlay ? h('div', {
                    className: 'utb-pick-outline',
                    'data-utb-pick-outline': 'true',
                    'data-utb-pick-selector': pickOverlay.selector || '',
                    'data-utb-pick-rect': JSON.stringify(pickOverlay.rect),
                    style: {
                      left: pickScreenNow.left,
                      top: pickScreenNow.top,
                      width: pickScreenNow.width,
                      height: pickScreenNow.height,
                    },
                  }) : null,
                  pickTagNow && pickOverlay ? h('span', {
                    className: 'utb-pick-tag',
                    'data-utb-pick-tag': pickOverlay.label,
                    title: pickOverlay.selector || pickOverlay.label,
                    style: { left: pickTagNow.left, top: pickTagNow.top },
                  }, pickOverlay.label) : null) : null)
              : h('div', { className: 'utb-empty' },
                h('strong', null, '正在启动内嵌浏览器'),
                '首次打开需要启动无头 Chromium，通常一两秒；完成后这里会显示实时画面。'))
            : h('div', { className: 'utb-empty' },
              h('strong', null, '预览网页'),
              error
                ? h('span', { role: 'alert', className: 'utb-empty-error' }, error)
                : '在上方输入 HTTP 或 HTTPS 网址。页面由内嵌的无头浏览器渲染，不会抢占桌面焦点；尺寸模式可模拟 393 × 852 等移动视口。')),
        h('div', { className: 'utb-status' },
          h('span', { className: 'utb-mode', 'data-mode': mode, title: '当前控制权归属' },
            h('span', { className: 'utb-dot', 'aria-hidden': true }),
            MODE_LABEL[remote.mode === 'agent' ? 'agent' : mode]),
          h('span', { className: 'utb-sep', 'aria-hidden': true }),
          h('span', { className: 'utb-perf', title: `实际显示帧率与端到端显示延迟（测量值）；传输：${transportKind === 'ws' ? 'WebSocket 推送' : 'HTTP 轮询'}` }, `${fps} FPS ${frameMs} ms`),
          // 选中数量是状态信息：放在底部延迟之后，而不是标注栏里的按钮/胶囊。
          annotSelectionCount() > 0 && h('span', {
            className: 'utb-annot-selected-status',
            role: 'status',
            'aria-live': 'polite',
            'data-utb-annot-selection-chip': String(annotSelectionCount()),
            title: '已选标注：拖动选框内任意位置移动，Delete / Backspace 删除，Esc 取消选择',
          }, '已选 ' + annotSelectionCount() + ' 个'),
          // v2 §11.3：标注同步状态（title + aria-live='polite'），不弹 modal、不写页面 lastError。
          h('span', {
            className: 'utb-annot-sync',
            'data-utb-annot-sync-status': annotSyncState,
            'data-utb-annot-sync-revision': String(annotSyncRevision),
            role: 'status',
            'aria-live': 'polite',
            title: annotSyncTitle,
            style: { display: annotSyncText ? 'inline' : 'none' },
          }, annotSyncText),
          h('span', { className: 'utb-gap' }),
          h('span', { className: 'utb-activity', title: remote.activity ? `运行时：${remote.activity}` : '视图状态' },
            remote.activity || activity))
        ];
      }
      const envOption = ENVIRONMENTS.find((item) => item.id === env) || { id: env, label: env, short: env };
      const envViewTitle = (envOption.short || envOption.label || env) + ' · 调试视图';
      const envViewSupported = typeof ENV_VIEWS[env] === 'function';

      /** 视图层没有该环境时占位：问号图标 + 一句人话，不留空白面板。 */
      function noEnvView() {
        const hostEnvOption = ENVIRONMENTS.find((item) => item.id === (resolvedEnvironment || 'web'));
        const hostEnvLabel = (hostEnvOption && (hostEnvOption.label || hostEnvOption.id)) || (resolvedEnvironment || 'Web 视图');
        return h('div', { className: 'utb-noview', 'data-utb-noview': env },
          h('span', { className: 'utb-noview-icon', 'aria-hidden': true },
            h('svg', { viewBox: '0 0 24 24', width: 28, height: 28, fill: 'none', stroke: 'currentColor', strokeWidth: 1.6, strokeLinecap: 'round', strokeLinejoin: 'round' },
              h('circle', { cx: 12, cy: 12, r: 9 }),
              h('path', { d: 'M9.6 9.4a2.5 2.5 0 1 1 3.5 2.3c-.6.3-1 .8-1 1.5v.4' }),
              h('circle', { cx: 12, cy: 17, r: .95, fill: 'currentColor', stroke: 'none' }))),
          h('div', { className: 'utb-noview-text' },
            h('strong', null, '视图层暂不支持'),
            h('p', null, (envOption.label || env) + ' 的调试视图还没有实现（适配器未接入）。'),
            h('p', { className: 'utb-noview-hint' }, '执行环境仍然是 ' + hostEnvLabel + '，这里只切换视图。'),
            h('p', { className: 'utb-noview-hint' }, '可以在设置页查看该环境的适配器与依赖状态。')));
      }

      return h('div', {
        className: 'utb',
        'data-utb-tabs-supported': tabsSupported ? 'true' : 'false',
        'data-utb-tabs-visible': showTabs ? 'true' : 'false',
        'data-utb-active-view': activeView ? String(activeView.id) : '',
        'data-utb-runtime-id': ui ? String(ui.runtimeId || '') : '',
        'data-utb-scope-binding': String(scope.binding || ''),
        'data-utb-views-count': stableViews ? String(stableViews.views.length) : '0',
        'data-utb-ready-views': String(readyViewList.length),
        'data-utb-tabs-pref': tabsVisible ? 'true' : 'false',
        'data-utb-active-busy': activeBusy ? 'true' : 'false',
        'data-utb-display-mode': displayMode,
        // 组合框当前选中的目标环境，以及视图层是否已实现该环境
        'data-utb-build': CLIENT_BUILD,
        'data-utb-view': env,
        'data-utb-view-supported': envViewSupported ? 'true' : 'false',
        onPointerDown: markHuman,
        onKeyDown: markHuman,
        onWheel: markHuman,
      },
        h('style', null, CSS),
        h('div', { className: 'utb-top' },
          h('span', { className: 'utb-env-icon', 'aria-hidden': true }, h(IconWindow, null)),
          h('div', { className: 'utb-env-text' },
            h('span', { className: 'utb-env-title', 'data-utb-env-title': env }, envViewTitle)),
          h('span', { className: 'utb-gap' }),
          // Web-view-only run-mode switch: headless (default) vs headed (visible window + profile).
          env === 'web' && envViewSupported && h('div', {
            className: 'utb-seg utb-display-seg',
            role: 'group',
            'aria-label': '运行模式',
            'data-utb-display-mode': displayMode,
          },
            [['headless', '无头'], ['headed', '有头']].map(([id, label]) => {
              const description = id === 'headed'
                ? '有头模式（离屏隐藏窗口 + 持久 profile）\n'
                  + '· 真实有头 Chromium，较不易被反爬识别；需要登录/过风控的站点用它\n'
                  + '· 登录态 / Cookie 跨重启保留\n'
                  + '· 启动较慢；切换会关闭所有页面，需重新打开'
                : '无头模式（默认）\n'
                  + '· 不显示浏览器窗口，启动快、资源占用低\n'
                  + '· 容易被反爬 / 风控识别（Cloudflare、Turnstile 等会持续挑战或 403）\n'
                  + '· 每次启动使用临时 profile，不保留登录态';
              return h('button', {
                key: id,
                type: 'button',
                className: 'utb-seg-btn',
                'aria-pressed': displayMode === id,
                'aria-description': description,
                'data-utb-display': id,
                title: description,
                disabled: displaySwitching,
                onClick: () => changeDisplayMode(id),
              }, segDot(displayMode === id, 'display'), label);
            })),
          h('label', { className: 'utb-env-pick' },
            h('span', { className: 'utb-sr' }, '选择运行环境'),
            h('select', {
              className: 'utb-select',
              value: env,
              'aria-label': '选择运行环境',
              disabled: annotOn || envBusy,
              title: envBusy ? '正在提交到宿主…' : (hostConfig.state.error || undefined),
              'data-utb-env-busy': envBusy ? 'true' : 'false',
              onChange: (e) => changeEnv(e.target.value),
              // 打开下拉时重读一次：另一个窗口改了开关，这里也能立刻看到最新的可选项
              onFocus: () => { if (hostConfig && typeof hostConfig.reload === 'function') hostConfig.reload(); },
            // 没有视图的环境也允许选：选中后渲染空态（只切视图，不写宿主配置）。
            // 只有“有视图但宿主不允许执行”的环境才禁用。
            }, envOptions.map((option) => h('option', {
              key: option.id,
              value: option.id,
              'data-utb-env-enabled': 'true',
            }, option.label))),
            h('span', { className: 'utb-env-caret', 'aria-hidden': true }, h(IconChevron, null))),
          (hostConfig.state.error || envNotice) ? h('span', {
            className: 'utb-env-error',
            role: 'alert',
            'data-uts-config-error': hostConfig.state.error ? 'read' : 'select',
            title: hostConfig.state.error || envNotice,
          }, hostConfig.state.error || envNotice) : null),
                  ...(envViewSupported ? ENV_VIEWS[env]() : [noEnvView()]));
    }

    /* =====================================================================================
     * DSH 设置页：第五节点为卡片目标；第三节点接口与第四节点执行端以同级标签展示。
     * 配置与就绪状态来自 Host（GET/PUT /config）：页面只提交意图，Host revision 是唯一真值。
     * Host 未提供接口时页面保持可用，但明确显示读取失败，绝不把任何目标标成已就绪或显示版本。
     * ===================================================================================== */
    const TARGET_CHAINS = {
      chromium: { communication: 'CDP', backend: 'Chromium DevTools' },
      electron: { communication: 'CDP / RPC', backend: 'Electron DevTools / 桌面自动化服务' },
      linux: { communication: 'D-Bus / X11 / Wayland', backend: 'AT-SPI / 桌面输入服务' },
      webkitgtk: { communication: 'WebKit Inspector / D-Bus', backend: 'WebKitGTK 调试后端 / AT-SPI' },
      windows: { communication: 'RPC / 系统 API', backend: 'UI Automation / 桌面输入服务' },
      webview2: { communication: 'CDP / RPC', backend: 'WebView2 DevTools / UI Automation' },
      macos: { communication: 'RPC / 系统 API', backend: 'Accessibility / 桌面输入服务' },
      wkwebview: { communication: 'WebKit Inspector / RPC', backend: 'WebKit 调试后端 / Accessibility' },
      android: { communication: 'ADB / RPC', backend: 'UI Automator / 系统输入服务' },
      androidWeb: { communication: 'ADB / CDP', backend: 'UI Automator / WebView DevTools' },
      terminal: { communication: 'PTY / IPC', backend: '终端会话服务' },
      harmonyos: { communication: 'HDC / RPC', backend: 'UiTest / 系统输入服务' },
      native3d: { communication: 'RPC / IPC', backend: '桌面自动化服务 / 应用辅助程序' },
    };

    /** 每张卡片表示运行中的应用类型；框架只作为技术栈说明。状态来自 Host 就绪结果。 */
    function plannedTarget(id, name, note, chain) {
      return { id, name, note, chain, state: 'planned' };
    }

    function miniProgramTarget(id, platform) {
      return plannedTarget(id, platform + '小程序', '运行于' + platform + '小程序容器的应用', {
        communication: '平台自动化接口（待选）', backend: platform + '开发者工具 / 辅助程序（待选）',
      });
    }

    const TARGET_ENV_GROUPS = [
      {
        id: 'web', title: 'Web 视图',
        targets: [
          { id: 'chrome', name: 'Chrome', note: 'Chrome / Chromium 中运行的网页', chain: TARGET_CHAINS.chromium,
            state: 'supported' },
          // Edge 与 Chrome 共用 CDP 执行端，已是「已实现」；是否真的可跑仍由 Host 就绪的依赖轴
          // （providers.edge.axes.dependency）回答，卡片不得据此显示成「可用」。
          Object.assign(plannedTarget('edge', 'Edge', 'Edge 中运行的网页', {
            communication: 'CDP', backend: 'Edge DevTools',
          }), { state: 'supported' }),
          Object.assign(plannedTarget('firefox', 'Firefox', 'Firefox 中运行的网页', {
            communication: 'WebDriver BiDi', backend: 'Firefox Remote Agent',
          }), { state: 'unsupported' }),
        ],
      },
      {
        id: 'linux', title: 'Linux 视图',
        targets: [
          plannedTarget('linux-native', 'Linux 原生桌面应用', 'GTK / Qt / Flutter 等原生窗口', TARGET_CHAINS.linux),
          plannedTarget('electron', 'Electron 应用', 'Chromium 页面与原生应用窗口', TARGET_CHAINS.electron),
          plannedTarget('tauri', 'Tauri 应用', 'WebKitGTK 页面与原生应用窗口', TARGET_CHAINS.webkitgtk),
        ],
      },
      {
        id: 'windows', title: 'Windows 视图',
        targets: [
          plannedTarget('windows-native', 'Windows 原生桌面应用', 'Win32 / Qt / Flutter 等原生窗口', TARGET_CHAINS.windows),
          plannedTarget('dotnet', '.NET 桌面应用', 'WPF / Windows Forms', TARGET_CHAINS.windows),
          plannedTarget('winui3', 'WinUI 3 应用', 'Windows App SDK 应用', TARGET_CHAINS.windows),
          plannedTarget('win-electron', 'Electron 应用', 'Chromium 页面与原生应用窗口', TARGET_CHAINS.electron),
          plannedTarget('win-tauri', 'Tauri 应用', 'WebView2 页面与原生应用窗口', TARGET_CHAINS.webview2),
        ],
      },
      {
        id: 'macos', title: 'macOS 视图',
        targets: [
          plannedTarget('macos-native', 'macOS 原生桌面应用', 'AppKit / SwiftUI / Qt / Flutter', TARGET_CHAINS.macos),
          plannedTarget('mac-electron', 'Electron 应用', 'Chromium 页面与原生应用窗口', TARGET_CHAINS.electron),
          plannedTarget('mac-tauri', 'Tauri 应用', 'WKWebView 页面与原生应用窗口', TARGET_CHAINS.wkwebview),
        ],
      },
      {
        id: 'android', title: 'Android 视图',
        targets: [
          plannedTarget('android-native', 'Android 原生应用', 'Android Views / Jetpack Compose', TARGET_CHAINS.android),
          plannedTarget('android-webview', 'Android WebView 应用', '内嵌网页；Capacitor / Cordova', TARGET_CHAINS.androidWeb),
          plannedTarget('android-flutter', 'Flutter Android 应用', 'Flutter 引擎渲染的应用', TARGET_CHAINS.android),
          plannedTarget('react-native', 'React Native 应用', 'Android 原生视图与 JS 运行时', TARGET_CHAINS.android),
        ],
      },
      {
        id: 'tui', title: 'TUI 视图',
        targets: [
          plannedTarget('python-tui', 'Python 终端应用', 'Textual 等终端界面', TARGET_CHAINS.terminal),
          plannedTarget('node-tui', 'Node.js 终端应用', 'Ink / blessed 等终端界面', TARGET_CHAINS.terminal),
          plannedTarget('go-tui', 'Go 终端应用', 'Bubble Tea 等终端界面', TARGET_CHAINS.terminal),
          plannedTarget('rust-tui', 'Rust 终端应用', 'Ratatui 等终端界面', TARGET_CHAINS.terminal),
        ],
      },
      {
        id: 'harmonyos', title: 'HarmonyOS 视图',
        targets: [
          plannedTarget('harmony-native', '鸿蒙原生应用', 'ArkUI / ArkTS', TARGET_CHAINS.harmonyos),
          plannedTarget('arkui-x', 'ArkUI-X 应用', 'ArkUI 跨平台应用', TARGET_CHAINS.harmonyos),
          plannedTarget('harmony-flutter', 'Flutter 鸿蒙应用', 'Flutter 鸿蒙适配应用', TARGET_CHAINS.harmonyos),
          plannedTarget('harmony-rn', 'React Native 鸿蒙应用', 'React Native 鸿蒙适配应用', TARGET_CHAINS.harmonyos),
        ],
      },
      {
        id: 'game', title: '游戏视图',
        targets: [
          plannedTarget('unity', 'Unity 游戏', 'Unity Player 中运行的游戏', {
            communication: 'RPC / IPC', backend: 'Unity 调试辅助程序（待选）',
          }),
          plannedTarget('unreal', 'Unreal 游戏', 'Unreal Engine 游戏实例', {
            communication: 'RPC / IPC', backend: 'Unreal 调试辅助程序（待选）',
          }),
          plannedTarget('godot', 'Godot 游戏', 'Godot 游戏实例', {
            communication: '引擎调试协议 / RPC', backend: 'Godot 调试后端 / 辅助程序（待选）',
          }),
          plannedTarget('cocos', 'Cocos 游戏', 'Cocos 原生或 Web 游戏实例', {
            communication: 'CDP / RPC', backend: 'DevTools / 引擎辅助程序（待选）',
          }),
        ],
      },
      {
        id: 'three-d', title: '3D 视图',
        targets: [
          plannedTarget('web-3d', 'Web 三维应用', 'Three.js / Babylon.js / PlayCanvas；WebGL / WebGPU', TARGET_CHAINS.chromium),
          plannedTarget('native-3d', '原生三维应用', '原生窗口中的三维场景', TARGET_CHAINS.native3d),
          plannedTarget('three-unity', 'Unity 三维应用', 'Unity Player 中的交互式三维场景', {
            communication: 'RPC / IPC', backend: 'Unity 调试辅助程序（待选）',
          }),
          // 用户 2026-11-10 要求：3D 场景补上建模/动画工具。它们都是原生桌面程序，
          // 没有现成调试协议，先按 native3d 链路登记为 planned，避免"3D 只有引擎"的误解。
          plannedTarget('blender', 'Blender', 'Blender 场景、模型与渲染设置界面', {
            communication: 'Python / RPC（bpy 待评估）', backend: 'Blender 内置 Python 控制台（待实现）',
          }),
          plannedTarget('3dsmax', '3ds Max', '3ds Max 场景、模型与材质编辑器', {
            communication: 'RPC / IPC（MAXScript 待评估）', backend: '3ds Max 脚本与辅助程序（待实现）',
          }),
          plannedTarget('mmd', 'MikuMikuDance（MMD）', 'MMD 动画、模型预览与动作编辑（PMD/PMX/VMD）', {
            communication: 'RPC / IPC（待评估）', backend: 'MMD 辅助程序（待实现）',
          }),
          plannedTarget('pmx-editor', 'PMX Editor', 'PMX 模型结构、材质与变形编辑', {
            communication: 'RPC / IPC（待评估）', backend: 'PMX Editor 辅助程序（待实现）',
          }),
        ],
      },
      {
        id: 'miniprogram', title: '小程序视图',
        targets: [
          miniProgramTarget('wechat', '微信'),
          miniProgramTarget('alipay', '支付宝'),
          miniProgramTarget('douyin', '抖音'),
          miniProgramTarget('qq', 'QQ'),
          miniProgramTarget('baidu', '百度智能'),
          miniProgramTarget('kuaishou', '快手'),
          miniProgramTarget('jd', '京东'),
          miniProgramTarget('meituan', '美团'),
          miniProgramTarget('xiaohongshu', '小红书'),
          miniProgramTarget('taobao', '淘宝'),
          miniProgramTarget('dingtalk', '钉钉'),
        ],
      },
    ];

    /** 设置页样式：只作用于 `.uts-*`，不覆盖宿主设置页的其它样式。 */
    const TARGET_ENV_CSS = `
.uts-settings { display: flex; flex-direction: column; gap: 20px; font-size: 13px; line-height: 20px; color: var(--dsw-alias-label-primary); }
.uts-head { display: flex; flex-direction: column; gap: 4px; }
.uts-head-row { display: flex; align-items: center; justify-content: space-between; flex-wrap: wrap; gap: 8px 12px; }
.uts-filter { display: inline-flex; align-items: center; gap: 8px; margin-left: auto; color: var(--dsw-alias-label-secondary); font-size: 12px; }
.uts-page-title { margin: 0; font-size: 16px; font-weight: 500; line-height: 24px; }
.uts-page-desc { margin: 0; font-size: 13px; line-height: 20px; color: var(--dsw-alias-label-secondary); }
.uts-body { display: flex; flex-direction: column; gap: 12px; }
.uts-title { margin: 0; font-size: 14px; font-weight: 600; line-height: 20px; }
.uts-chain-guide { margin: 0; color: var(--dsw-alias-label-secondary); font-size: 12px; line-height: 20px; overflow-wrap: anywhere; }
.uts-groups { display: flex; flex-direction: column; gap: 18px; }
.uts-group { display: flex; flex-direction: column; gap: 8px; }
.uts-group-heading { display: flex; align-items: center; gap: 8px; margin: 0; font-size: 13px; font-weight: 600; line-height: 20px; }
.uts-card-head { display: flex; align-items: flex-start; justify-content: space-between; gap: 8px; }
.uts-card-title { display: inline-flex; align-items: center; flex-wrap: wrap; gap: 6px; min-width: 0; }
.uts-card-switch { flex: none; display: inline-flex; align-items: center; }
.uts-card-foot { display: flex; align-items: flex-end; justify-content: space-between; gap: 8px; margin-top: auto; }
.uts-card-actions { display: flex; gap: 6px; }
.uts-card-foot .uts-card-actions { margin: 0 0 0 auto; }
.uts-diagnose-btn { box-sizing: border-box; padding: 2px 8px; font: inherit; font-size: 11px; line-height: 16px; color: var(--dsw-alias-label-secondary); background: transparent; border: .5px solid var(--dsw-alias-border-l2); border-radius: 6px; cursor: pointer; }
.uts-diagnose-btn:hover { color: var(--dsw-alias-label-primary); border-color: var(--dsw-alias-border-l1); }
.uts-diagnostics .uts-axes { margin-top: 8px; }
.uts-diagnostics .uts-head-row { gap: 8px; }
.uts-group-env { display: inline-flex; align-items: center; gap: 6px; margin-left: auto; padding: 2px 8px; font-size: 12px; font-weight: 400; color: var(--dsw-alias-label-secondary); }
.uts-group-toggle { display: flex; align-items: center; gap: 8px; width: 100%; margin: 0; padding: 4px 8px; font: inherit; font-weight: 600; line-height: 20px; color: var(--dsw-alias-label-primary); text-align: left; background: transparent; border: 0; border-radius: 8px; cursor: pointer; }
.uts-group-toggle:hover { background: var(--dsw-alias-bg-layer-2); }
.uts-group-toggle:focus-visible { outline: 2px solid var(--dsw-alias-brand-primary); outline-offset: 1px; }
.uts-group-title { min-width: 0; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
.uts-group-count { flex: 0 0 auto; color: var(--dsw-alias-label-tertiary); font-size: 12px; font-weight: 400; }
.uts-group-chevron { flex: 0 0 auto; margin-left: auto; display: grid; place-items: center; color: var(--dsw-alias-label-secondary); transform: rotate(-90deg); transition: transform .15s ease; }
.uts-group[data-uts-expanded="true"] .uts-group-chevron { transform: rotate(0deg); }
.uts-cards { display: grid; grid-template-columns: repeat(auto-fill, minmax(160px, 1fr)); gap: 12px 20px; }
.uts-item { display: flex; flex-direction: column; min-width: 0; }
.uts-card { box-sizing: border-box; width: 100%; flex: 1 1 auto; display: flex; flex-direction: column; gap: 8px; padding: 12px 14px; border: .5px solid var(--dsw-alias-border-l2); border-radius: 12px; background: var(--dsw-alias-bg-layer-1); }
.uts-card-name { font-size: 13px; font-weight: 600; line-height: 20px; overflow-wrap: anywhere; }
.uts-card-note { display: -webkit-box; -webkit-box-orient: vertical; -webkit-line-clamp: 2; line-clamp: 2; overflow: hidden;
  font-size: 12px; line-height: 18px; max-height: 36px; color: var(--dsw-alias-label-tertiary); overflow-wrap: anywhere; }
.uts-field { display: flex; flex-direction: column; gap: 2px; min-width: 0; }
.uts-field-inline { flex-direction: row; align-items: center; gap: 8px; }
.uts-field-label { font-size: 12px; line-height: 18px; color: var(--dsw-alias-label-secondary); }
.uts-field-value { font-size: 12px; line-height: 18px; color: var(--dsw-alias-label-primary); font-variant-numeric: tabular-nums; overflow-wrap: anywhere; }
.uts-field-value[data-uts-valid="false"], .uts-field-value[data-uts-valid="unknown"] { color: var(--dsw-alias-label-tertiary); }
.uts-empty { margin: 0; font-size: 12px; line-height: 18px; color: var(--dsw-alias-label-tertiary); }
.uts-tags { display: flex; flex-wrap: wrap; align-items: flex-start; gap: 6px; margin-top: auto; min-width: 0; }
.uts-card-state { font-size: 12px; line-height: 18px; color: var(--dsw-alias-label-tertiary); }
.uts-tag { box-sizing: border-box; display: inline-flex; align-items: center; min-height: 18px; max-width: 100%; padding: 2px 7px; border-radius: 6px; font-size: 11px; line-height: 16px; white-space: normal; overflow-wrap: anywhere; color: var(--dsw-alias-label-tertiary); background: var(--dsw-alias-bg-layer-2); border: .5px solid var(--dsw-alias-border-l2); }
.uts-tag[data-uts-tag="supported"] { color: #16a34a; background: color-mix(in srgb, #16a34a 12%, transparent); border-color: color-mix(in srgb, #16a34a 35%, transparent); }
.uts-chain { margin-top: 0; margin-bottom: 10px; }
.uts-axes { display: grid; grid-template-columns: repeat(auto-fill, minmax(150px, 1fr)); gap: 6px 14px; padding: 8px 10px; border: .5px dashed var(--dsw-alias-border-l2); border-radius: 8px; background: var(--dsw-alias-bg-layer-1); }
.uts-axis { display: flex; flex-direction: column; min-width: 0; }
.uts-axis-head { display: flex; align-items: baseline; gap: 6px; min-width: 0; }
.uts-axis-label { font-size: 11px; line-height: 16px; color: var(--dsw-alias-label-secondary); }
.uts-axis-status { font-size: 11px; line-height: 16px; font-weight: 600; color: var(--dsw-alias-label-tertiary); }
.uts-axis-reason { font-size: 11px; line-height: 16px; color: var(--dsw-alias-label-tertiary); overflow-wrap: anywhere; }
.uts-axis[data-uts-status="supported"] .uts-axis-status,
.uts-axis[data-uts-status="ok"] .uts-axis-status,
.uts-axis[data-uts-status="bound"] .uts-axis-status,
.uts-axis[data-uts-status="available"] .uts-axis-status,
.uts-axis[data-uts-status="true"] .uts-axis-status { color: #16a34a; }
.uts-axis[data-uts-status="failed"] .uts-axis-status,
.uts-axis[data-uts-status="degraded"] .uts-axis-status,
.uts-axis[data-uts-status="stale"] .uts-axis-status,
.uts-axis[data-uts-status="partial"] .uts-axis-status,
.uts-axis[data-uts-status="unavailable"] .uts-axis-status { color: #d97706; }
.uts-config-error { margin: 0; padding: 8px 10px; border-radius: 8px; font-size: 12px; line-height: 18px; color: #b91c1c; background: color-mix(in srgb, #b91c1c 10%, transparent); border: .5px solid color-mix(in srgb, #b91c1c 30%, transparent); overflow-wrap: anywhere; }
.uts-config-meta { display: flex; flex-wrap: wrap; gap: 4px 12px; margin: 0; font-size: 11px; line-height: 16px; color: var(--dsw-alias-label-tertiary); }
.uts-config-actions { display: flex; align-items: center; flex-wrap: wrap; gap: 8px 12px; margin-left: auto; }
.uts-link-btn { padding: 2px 8px; font: inherit; font-size: 12px; line-height: 18px; color: var(--dsw-alias-brand-primary); background: transparent; border: .5px solid var(--dsw-alias-border-l2); border-radius: 6px; cursor: pointer; }
.uts-link-btn:disabled { color: var(--dsw-alias-label-tertiary); cursor: not-allowed; }
.uts-switch { position: relative; display: inline-flex; align-items: center; width: 32px; height: 18px; flex: 0 0 auto; cursor: pointer; }
.uts-switch-input { position: absolute; inset: 0; width: 100%; height: 100%; margin: 0; opacity: 0; cursor: inherit; }
.uts-switch-input:disabled { cursor: not-allowed; }
.uts-switch-track { position: relative; display: block; width: 32px; height: 18px; border-radius: 999px; background: var(--dsw-alias-bg-layer-3, color-mix(in srgb, var(--dsw-alias-label-primary) 18%, transparent)); transition: background-color .15s ease; }
.uts-switch-thumb { position: absolute; top: 2px; left: 2px; width: 14px; height: 14px; border-radius: 50%; background: #fff; box-shadow: 0 1px 2px rgba(0, 0, 0, .28); transition: transform .15s ease; }
.uts-switch-input:checked + .uts-switch-track { background: var(--dsw-alias-brand-primary); }
.uts-switch-input:checked + .uts-switch-track .uts-switch-thumb { transform: translateX(14px); }
.uts-switch-input:disabled + .uts-switch-track { opacity: .45; }
.uts-switch-input:focus-visible + .uts-switch-track { outline: 2px solid var(--dsw-alias-brand-primary); outline-offset: 2px; }
@media (prefers-reduced-motion: reduce) { .uts-switch-track, .uts-switch-thumb, .uts-group-chevron { transition: none; } }
/* --- 诊断页四个板块：实时调试拓扑 / 各模块诊断状态（六轴卡片）/ 诊断日志 / 调试节点职责 --- */
.uts-diag-summary { display: flex; align-items: center; flex-wrap: wrap; gap: 6px 12px; }
.uts-diag-overall { box-sizing: border-box; display: inline-flex; align-items: center; gap: 7px; padding: 3px 11px; border-radius: 999px; font-size: 12px; line-height: 18px; color: #d97706; background: color-mix(in srgb, #d97706 12%, transparent); border: .5px solid color-mix(in srgb, #d97706 38%, transparent); }
/* 胶囊跟随五态（旧的三态 ready/pending/broken 已全部退役，写成 ready 会永远不匹配、只剩默认橙色）。 */
.uts-diag-overall[data-uts-overall="PASS"] { color: #16a34a; background: color-mix(in srgb, #16a34a 12%, transparent); border-color: color-mix(in srgb, #16a34a 38%, transparent); }
.uts-diag-overall[data-uts-overall="WARN"] { color: #d97706; background: color-mix(in srgb, #d97706 12%, transparent); border-color: color-mix(in srgb, #d97706 38%, transparent); }
.uts-diag-overall[data-uts-overall="FAIL"] { color: #b91c1c; background: color-mix(in srgb, #b91c1c 12%, transparent); border-color: color-mix(in srgb, #b91c1c 38%, transparent); }
.uts-diag-overall[data-uts-overall="SKIPPED"] { color: var(--dsw-alias-label-tertiary); background: color-mix(in srgb, var(--dsw-alias-label-primary) 6%, transparent); border-style: dashed; border-color: color-mix(in srgb, var(--dsw-alias-label-tertiary) 55%, transparent); }
.uts-diag-overall[data-uts-overall="UNKNOWN"] { color: var(--dsw-alias-label-tertiary); background: color-mix(in srgb, var(--dsw-alias-label-primary) 4%, transparent); border-style: dotted; border-color: color-mix(in srgb, var(--dsw-alias-label-tertiary) 45%, transparent); }
.uts-diag-overall-dot { flex: none; width: 6px; height: 6px; border-radius: 50%; background: currentColor; }
.uts-diag-stale { flex: 1 1 100%; margin: 0; font-size: 11px; line-height: 16px; color: #d97706; overflow-wrap: anywhere; }
.uts-diag-panel { display: flex; flex-direction: column; gap: 10px; padding: 13px 15px; border: .5px solid var(--dsw-alias-border-l2); border-radius: 12px; background: var(--dsw-alias-bg-layer-1); }
.uts-diag-panel-head { display: flex; align-items: baseline; justify-content: space-between; flex-wrap: wrap; gap: 4px 12px; }
.uts-diag-panel-title { margin: 0; font-size: 13px; font-weight: 600; line-height: 20px; }
.uts-diag-flow { margin: 0; font-size: 10px; line-height: 15px; color: var(--dsw-alias-label-tertiary); overflow-wrap: anywhere; }
.uts-diag-chain-scroll { overflow-x: auto; overflow-y: hidden; padding-bottom: 2px; }
.uts-diag-chain { position: relative; display: grid; grid-template-columns: minmax(0, 1fr) 56px minmax(0, 1fr) 56px minmax(0, 1fr) 56px minmax(0, 1fr) 56px minmax(0, 1fr); align-items: center; min-width: 760px; padding-top: 16px; }
/* 纯装饰导轨（不承载状态）：虚线 + 右端静态小点，颜色只取中性值。 */
.uts-diag-rail { position: absolute; left: 7.5%; right: 7.5%; top: 4px; height: 0; border-top: 1px dashed color-mix(in srgb, var(--dsw-alias-label-tertiary) 55%, transparent); pointer-events: none; }
.uts-diag-rail-dot { position: absolute; right: -2px; top: -3px; width: 5px; height: 5px; border-radius: 50%; background: color-mix(in srgb, var(--dsw-alias-label-tertiary) 70%, transparent); opacity: .65; }
.uts-diag-node { box-sizing: border-box; display: flex; flex-direction: column; gap: 3px; min-width: 0; padding: 10px 11px; border: .5px solid var(--dsw-alias-border-l2); border-radius: 10px; background: var(--dsw-alias-bg-layer-2); }
.uts-diag-node[data-uts-node-state="PASS"] { border-color: color-mix(in srgb, #16a34a 42%, transparent); }
.uts-diag-node[data-uts-node-state="WARN"] { border-color: color-mix(in srgb, #d97706 42%, transparent); }
.uts-diag-node[data-uts-node-state="FAIL"] { border-color: color-mix(in srgb, #b91c1c 45%, transparent); }
.uts-diag-node[data-uts-node-state="SKIPPED"] { border-style: dashed; border-color: color-mix(in srgb, var(--dsw-alias-label-tertiary) 55%, transparent); }
.uts-diag-node[data-uts-node-state="UNKNOWN"] { border-style: dashed; border-color: color-mix(in srgb, var(--dsw-alias-label-tertiary) 40%, transparent); }
.uts-diag-node[data-uts-stage-phase="running"] { border-color: var(--dsw-alias-brand-primary); animation: uts-diag-pulse 1s ease-in-out infinite alternate; }
@keyframes uts-diag-pulse { from { box-shadow: 0 0 0 0 color-mix(in srgb, var(--dsw-alias-brand-primary) 0%, transparent); } to { box-shadow: 0 0 0 3px color-mix(in srgb, var(--dsw-alias-brand-primary) 22%, transparent); } }
.uts-diag-node-top { display: flex; align-items: center; justify-content: space-between; gap: 6px; }
.uts-diag-node-index { font-size: 9px; line-height: 14px; letter-spacing: .1em; color: var(--dsw-alias-label-tertiary); }
.uts-diag-node-glyph { display: grid; place-items: center; flex: none; width: 24px; height: 24px; border-radius: 7px; color: var(--dsw-alias-label-tertiary); background: color-mix(in srgb, var(--dsw-alias-label-primary) 6%, transparent); }
.uts-diag-node[data-uts-node-state="PASS"] .uts-diag-node-glyph { color: #16a34a; background: color-mix(in srgb, #16a34a 12%, transparent); }
.uts-diag-node[data-uts-node-state="WARN"] .uts-diag-node-glyph { color: #d97706; background: color-mix(in srgb, #d97706 12%, transparent); }
.uts-diag-node[data-uts-node-state="FAIL"] .uts-diag-node-glyph { color: #b91c1c; background: color-mix(in srgb, #b91c1c 12%, transparent); }
.uts-diag-node-role { font-size: 10px; line-height: 15px; color: var(--dsw-alias-label-tertiary); }
.uts-diag-node-name { font-size: 12px; font-weight: 600; line-height: 18px; color: var(--dsw-alias-label-primary); overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
/* 职责描述固定占两行（15px × 2 = 30px）：卡片高度不随文案长短跳动 */
.uts-diag-node-sub { display: -webkit-box; -webkit-box-orient: vertical; -webkit-line-clamp: 2; overflow: hidden; min-height: 30px; font-size: 10px; line-height: 15px; color: var(--dsw-alias-label-secondary); }
.uts-diag-node-status { display: flex; align-items: flex-start; gap: 5px; min-width: 0; font-size: 10px; line-height: 15px; color: var(--dsw-alias-label-tertiary); }
/* 状态信息预留两行（30px = 2 × 15px），超出两行才截断；完整内容在节点悬停提示里。 */
.uts-diag-node-status > span { min-width: 0; min-height: 30px; display: -webkit-box; -webkit-box-orient: vertical; -webkit-line-clamp: 2; overflow: hidden; overflow-wrap: anywhere; }
.uts-diag-node[data-uts-node-state="WARN"] .uts-diag-node-status { color: #d97706; }
.uts-diag-node[data-uts-node-state="FAIL"] .uts-diag-node-status { color: #b91c1c; }
.uts-diag-dot { flex: none; width: 5px; height: 5px; margin-top: 5px; border-radius: 50%; background: var(--dsw-alias-label-tertiary); }
.uts-diag-node[data-uts-node-state="PASS"] .uts-diag-dot { background: #16a34a; }
.uts-diag-node[data-uts-node-state="WARN"] .uts-diag-dot { background: #d97706; }
.uts-diag-node[data-uts-node-state="FAIL"] .uts-diag-dot { background: #b91c1c; }
.uts-diag-edge { position: relative; display: flex; align-items: center; justify-content: center; align-self: center; width: 100%; }
.uts-diag-edge-line { position: relative; display: block; width: 100%; height: 1.5px; background: #16a34a; }
.uts-diag-edge[data-uts-edge-state="PASS"] .uts-diag-edge-line { background: #16a34a; }
.uts-diag-edge[data-uts-edge-state="PASS"] .uts-diag-edge-line::before { content: ""; position: absolute; top: 50%; right: 0; transform: translateY(-50%); border-left: 4px solid #16a34a; border-top: 3px solid transparent; border-bottom: 3px solid transparent; }
.uts-diag-edge[data-uts-edge-state="WARN"] .uts-diag-edge-line { background: #d97706; }
.uts-diag-edge[data-uts-edge-state="WARN"] .uts-diag-edge-label { color: #d97706; }
.uts-diag-edge[data-uts-edge-state="SKIPPED"] .uts-diag-edge-line { background: repeating-linear-gradient(90deg, color-mix(in srgb, var(--dsw-alias-label-tertiary) 60%, transparent) 0 4px, transparent 4px 8px); }
.uts-diag-edge[data-uts-edge-state="UNKNOWN"] .uts-diag-edge-line { background: repeating-linear-gradient(90deg, color-mix(in srgb, var(--dsw-alias-label-tertiary) 45%, transparent) 0 2px, transparent 2px 6px); }
.uts-diag-edge[data-uts-edge-state="FAIL"] .uts-diag-edge-line { background: repeating-linear-gradient(90deg, #b91c1c 0 4px, transparent 4px 8px); }
.uts-diag-edge[data-uts-edge-state="FAIL"] .uts-diag-edge-label { color: #b91c1c; }
/* 沿通路移动的小球：绝对定位，不参与布局；只有本 run 里 PASS 且下游已 stage-end 的段才跑。 */
.uts-diag-edge-dot { position: absolute; top: 50%; left: 0; width: 6px; height: 6px; margin-top: -3px; border-radius: 50%; background: #16a34a; box-shadow: 0 0 6px color-mix(in srgb, #16a34a 55%, transparent); opacity: .9; display: none; pointer-events: none; }
.uts-diag-edge[data-uts-edge-live="true"] .uts-diag-edge-dot { display: block; animation: uts-diag-flow 2.1s linear infinite; }
@keyframes uts-diag-flow { 0% { left: 0; opacity: 0; } 12% { opacity: .9; } 88% { opacity: .9; } 100% { left: calc(100% - 6px); opacity: 0; } }
.uts-diag-edge-break { position: absolute; display: grid; place-items: center; width: 15px; height: 15px; border-radius: 50%; font-size: 10px; line-height: 1; color: #b91c1c; background: var(--dsw-alias-bg-layer-1); border: .5px solid color-mix(in srgb, #b91c1c 50%, transparent); }
.uts-diag-edge-label { position: absolute; top: calc(50% + 7px); left: 50%; transform: translateX(-50%); font-size: 9px; line-height: 13px; color: var(--dsw-alias-label-tertiary); white-space: nowrap; }
.uts-diag-panel-head { display: flex; align-items: baseline; justify-content: space-between; flex-wrap: wrap; gap: 4px 12px; }
.uts-diag-panel-title { margin: 0; font-size: 13px; font-weight: 600; line-height: 20px; }
.uts-diag-flow { margin: 0; font-size: 10px; line-height: 15px; color: var(--dsw-alias-label-tertiary); overflow-wrap: anywhere; }
.uts-diag-flow { margin: 0; font-size: 10px; line-height: 15px; color: var(--dsw-alias-label-tertiary); overflow-wrap: anywhere; }
.uts-diag-axes { display: grid; grid-template-columns: repeat(auto-fit, minmax(180px, 1fr)); gap: 10px; }
.uts-diag-axis { box-sizing: border-box; display: flex; align-items: flex-start; gap: 10px; min-width: 0; padding: 11px 12px; border: .5px solid var(--dsw-alias-border-l2); border-radius: 12px; background: var(--dsw-alias-bg-layer-2); }
.uts-diag-axis-icon { flex: none; display: grid; place-items: center; width: 26px; height: 26px; border-radius: 8px; color: var(--dsw-alias-label-secondary); background: color-mix(in srgb, var(--dsw-alias-label-primary) 8%, transparent); }
.uts-diag-axis[data-uts-status="supported"] .uts-diag-axis-icon, .uts-diag-axis[data-uts-status="ok"] .uts-diag-axis-icon, .uts-diag-axis[data-uts-status="bound"] .uts-diag-axis-icon, .uts-diag-axis[data-uts-status="available"] .uts-diag-axis-icon, .uts-diag-axis[data-uts-status="true"] .uts-diag-axis-icon { color: #16a34a; background: color-mix(in srgb, #16a34a 12%, transparent); }
.uts-diag-axis[data-uts-status="failed"] .uts-diag-axis-icon, .uts-diag-axis[data-uts-status="degraded"] .uts-diag-axis-icon, .uts-diag-axis[data-uts-status="stale"] .uts-diag-axis-icon, .uts-diag-axis[data-uts-status="partial"] .uts-diag-axis-icon, .uts-diag-axis[data-uts-status="unavailable"] .uts-diag-axis-icon { color: #d97706; background: color-mix(in srgb, #d97706 12%, transparent); }
.uts-diag-axis-body { display: flex; flex-direction: column; gap: 3px; min-width: 0; flex: 1 1 auto; }
.uts-diag-axis-head { display: flex; align-items: baseline; justify-content: space-between; gap: 8px; min-width: 0; }
.uts-diag-axis-name { font-size: 11px; line-height: 16px; font-weight: 600; color: var(--dsw-alias-label-secondary); }
.uts-diag-axis-value { flex: none; font-size: 11px; line-height: 16px; font-weight: 600; white-space: nowrap; color: var(--dsw-alias-label-tertiary); }
.uts-diag-axis[data-uts-status="supported"] .uts-diag-axis-value, .uts-diag-axis[data-uts-status="ok"] .uts-diag-axis-value, .uts-diag-axis[data-uts-status="bound"] .uts-diag-axis-value, .uts-diag-axis[data-uts-status="available"] .uts-diag-axis-value, .uts-diag-axis[data-uts-status="true"] .uts-diag-axis-value { color: #16a34a; }
.uts-diag-axis[data-uts-status="failed"] .uts-diag-axis-value, .uts-diag-axis[data-uts-status="degraded"] .uts-diag-axis-value, .uts-diag-axis[data-uts-status="stale"] .uts-diag-axis-value, .uts-diag-axis[data-uts-status="partial"] .uts-diag-axis-value, .uts-diag-axis[data-uts-status="unavailable"] .uts-diag-axis-value, .uts-diag-axis[data-uts-status="unsupported"] .uts-diag-axis-value, .uts-diag-axis[data-uts-status="unbound"] .uts-diag-axis-value, .uts-diag-axis[data-uts-status="not-probed"] .uts-diag-axis-value, .uts-diag-axis[data-uts-status="false"] .uts-diag-axis-value { color: #d97706; }
.uts-diag-axis-reason { font-family: inherit; font-size: 10px; line-height: 16px; color: var(--dsw-alias-label-tertiary); overflow-wrap: anywhere; }
/* 占位固定三行（16px × 3）：六张卡片高度一致，且 run 结果变化时卡片不会跳动 */
.uts-diag-axis-checks { display: block; min-height: 48px; font-family: inherit; font-size: 10px; line-height: 16px; color: var(--dsw-alias-label-tertiary); }
/* 一行一项：不用分隔符串成一句，逐行列出更易读；单项过长用省略号，完整列表看悬停提示 */
.uts-diag-axis-checks-item { display: block; white-space: nowrap; overflow: hidden; text-overflow: ellipsis; }
/* 「+n」是计数标签：字号更小、颜色更淡，与描述文字明显区分 */
.uts-diag-axis-checks-more { margin-left: 5px; font-size: 9px; line-height: 16px; letter-spacing: .02em; color: color-mix(in srgb, var(--dsw-alias-label-tertiary) 55%, transparent); }
.uts-diag-bottom { display: grid; grid-template-columns: minmax(0, 1.15fr) minmax(0, .85fr); gap: 12px; }
.uts-diag-events { display: flex; flex-direction: column; gap: 7px; }
.uts-diag-event { display: grid; grid-template-columns: 62px 8px minmax(0, 1fr); align-items: start; gap: 8px; min-width: 0; font-size: 11px; line-height: 16px; }
.uts-diag-event-time { font-family: ui-monospace, SFMono-Regular, Consolas, monospace; font-size: 10px; line-height: 16px; color: var(--dsw-alias-label-tertiary); font-variant-numeric: tabular-nums; }
/* 圆点颜色只跟随事件状态（旧写法按 kind="change" 上橙色，把所有 stage 行都染成告警色）。 */
.uts-diag-event-pin { width: 5px; height: 5px; margin-top: 6px; border-radius: 50%; background: var(--dsw-alias-label-tertiary); }
.uts-diag-event-pin[data-uts-event-status="PASS"] { background: #16a34a; }
.uts-diag-event-pin[data-uts-event-status="WARN"] { background: #d97706; }
.uts-diag-event-pin[data-uts-event-status="FAIL"] { background: #b91c1c; }
.uts-diag-event-pin[data-uts-event-status="SKIPPED"] { background: color-mix(in srgb, var(--dsw-alias-label-tertiary) 85%, transparent); }
.uts-diag-event-pin[data-uts-event-status="UNKNOWN"] { background: color-mix(in srgb, var(--dsw-alias-label-tertiary) 60%, transparent); }
.uts-diag-event-pin[data-uts-event-status="INFO"] { background: var(--dsw-alias-label-tertiary); }
.uts-diag-event[data-uts-event-time-source="observed"] .uts-diag-event-time { font-style: italic; opacity: .75; }
.uts-diag-event-text { min-width: 0; color: var(--dsw-alias-label-secondary); overflow-wrap: anywhere; }
.uts-diag-duties { display: flex; flex-direction: column; gap: 8px; }
.uts-diag-duty { display: flex; align-items: flex-start; gap: 8px; font-size: 11px; line-height: 16px; color: var(--dsw-alias-label-secondary); overflow-wrap: anywhere; }
.uts-diag-duty-arrow { flex: none; color: #16a34a; }
.uts-diag-duty-text strong { font-weight: 600; color: var(--dsw-alias-label-primary); }
.uts-diag-empty { margin: 0; font-size: 11px; line-height: 16px; color: var(--dsw-alias-label-tertiary); }
@media (max-width: 900px) { .uts-diag-bottom { grid-template-columns: minmax(0, 1fr); } }
@media (prefers-reduced-motion: reduce) {
  .uts-diag-edge[data-uts-edge-live="true"] .uts-diag-edge-dot { animation: none; }
  .uts-diag-node[data-uts-stage-phase="running"] { animation: none; }
}
.uts-diag-modal-overlay { position: fixed; inset: 0; z-index: 3000; display: flex; align-items: center; justify-content: center; padding: 16px; background: rgba(0, 0, 0, .45); pointer-events: auto; }
.uts-diag-modal-panel { box-sizing: border-box; position: relative; display: flex; flex-direction: column; width: min(1180px, 94vw); max-height: 86vh; overflow: auto; border-radius: 14px; border: .5px solid var(--dsw-alias-border-l1); background: var(--dsw-alias-bg-layer-1); box-shadow: 0 24px 64px rgba(0, 0, 0, .32); }
.uts-diag-modal-head { position: sticky; top: 0; z-index: 1; display: flex; align-items: center; justify-content: space-between; gap: 12px; padding: 13px 16px; border-bottom: .5px solid var(--dsw-alias-border-l2); background: var(--dsw-alias-bg-layer-1); }
.uts-diag-modal-title { display: flex; align-items: center; gap: 8px; min-width: 0; }
.uts-diag-modal-close { flex: none; }
.uts-diag-modal-body { padding: 14px 16px 18px; }
.uts-diagnostics-body { display: flex; flex-direction: column; gap: 12px; }
.uts-diag-action { display: flex; align-items: center; flex-wrap: wrap; gap: 6px 10px; }

`;

    /* ---- Host config (M4): one authoritative revision for the settings page and the panel ---- */
    const SETTINGS_EXPANDED_KEY = 'dsh.ui-testing.settings.expanded';
    const AXIS_ORDER = ['support', 'enabled', 'dependency', 'connection', 'target', 'capability'];
    const AXIS_LABEL = {
      support: '工程支持', enabled: '用户启用', dependency: '依赖可用',
      connection: '连接可信', target: '目标绑定', capability: '能力就绪',
    };
    /** M0 §5.2 status vocabulary → the short text the page shows. Unknown values fall through. */
    const AXIS_TEXT = {
      support: { supported: '已实现', unsupported: '未支持', planned: '未接入', 'not-probed': '未探测' },
      enabled: { true: '已启用', false: '未启用', 'not-probed': '未知' },
      dependency: { ok: '可用', degraded: '降级', failed: '不可用', 'not-probed': '未探测' },
      connection: { ok: '可信', failed: '失败', 'not-probed': '未探测' },
      target: { bound: '已绑定', unbound: '未绑定', stale: '已失效', 'not-probed': '未探测' },
      capability: { available: '可用', partial: '部分可用', unavailable: '不可用', unsupported: '不支持', 'not-probed': '未探测' },
    };
    function axisText(axis, status) {
      const table = AXIS_TEXT[axis] || {};
      return table[status] || status || '未知';
    }

    /** One-line, human-readable detail for an axis tooltip (never invents missing facts). */
    function axisDetail(axis) {
      const parts = [];
      if (axis.targetId) parts.push('目标 ' + axis.targetId);
      if (axis.checkedAt) {
        const at = new Date(axis.checkedAt);
        parts.push('检查时间 ' + (Number.isNaN(at.getTime()) ? String(axis.checkedAt) : at.toISOString()));
      }
      if (axis.evidenceKind) parts.push('证据 ' + axis.evidenceKind);
      if (axis.checks && typeof axis.checks === 'object') {
        // readiness 轴历史上的 check 用 `ok`，诊断 run 的探测用 `pass`：两种都算通过（大小写不敏感），
        // 只有真正没通过的项才列进提示，别再把「六条全 pass」说成「未通过」。
        const statusOf = (check) => {
          if (typeof check === 'string') return check;
          if (check && typeof check === 'object' && typeof check.status === 'string') return check.status;
          return '';
        };
        const passed = (status) => ['ok', 'pass'].includes(String(status || '').toLowerCase());
        const rows = Object.entries(axis.checks).map(([name, check]) => ({
          name,
          status: statusOf(check),
          reason: check && typeof check === 'object' ? check.reason || '' : '',
        }));
        const failed = rows.filter((row) => !passed(row.status));
        if (failed.length) {
          parts.push('未通过 ' + failed.map((row) => row.name + '=' + (row.status || 'unknown') + (row.reason ? '(' + row.reason + ')' : '')).join(', '));
        } else if (rows.length) {
          parts.push('全部通过 ' + rows.map((row) => row.name + '=' + row.status).join(', '));
        }
      }
      return parts.join(' · ');
    }

    /* ---- Provider diagnostics page: topology / six axes / event stream / duties ---------------- */

    /**
     * Prototype display order for the six axes on the diagnostics page. `AXIS_ORDER` stays the
     * data/probe order (other code and the acceptance script read it), this one is presentation
     * only: it reorders the same six keys, it never adds or drops an axis.
     */
    const DIAG_AXIS_ORDER = ['support', 'target', 'enabled', 'capability', 'dependency', 'connection'];
    /** Diagnostics page polls the existing `/config?view=global`; no new Host endpoint. */
    const DIAG_POLL_MS = 5000;
    const DIAG_EVENT_LIMIT = 30;
    const DIAG_EVENT_ROWS = 8;

    /** Node ids are fixed by the prototype: five logical links from agent to target. */
    const DIAG_DUTY_TEXT = {
      agent: '理解任务目标，发起工具调用并消费诊断结果',
      controller: '统一调度，选择能力与执行路径',
      interface: '通过通信接口传递命令、事件与会话数据',
      backend: '调用浏览器调试执行后端执行操作',
      target: '提供实际运行状态与调试证据',
    };

    /** 14px inline SVG per axis/node — inline paths, never an external font, image or sprite. */
    function diagSvg(children) {
      return h('svg', {
        width: 14, height: 14, viewBox: '0 0 24 24', fill: 'none', stroke: 'currentColor',
        strokeWidth: 1.7, strokeLinecap: 'round', strokeLinejoin: 'round', 'aria-hidden': true,
      }, ...children);
    }
    function diagAxisIcon(axisKey) {
      if (axisKey === 'support') {
        return diagSvg([h('path', { key: 'a', d: 'm12 3 8 4v5c0 5-3.5 8-8 9-4.5-1-8-4-8-9V7l8-4Z' }),
          h('path', { key: 'b', d: 'm8 12 2.5 2.5L16 9' })]);
      }
      if (axisKey === 'target') {
        return diagSvg([h('path', { key: 'a', d: 'M10 13a5 5 0 0 0 7.1 0l2-2a5 5 0 0 0-7.1-7.1l-1.1 1.1' }),
          h('path', { key: 'b', d: 'M14 11a5 5 0 0 0-7.1 0l-2 2A5 5 0 0 0 12 20.1l1.1-1.1' })]);
      }
      if (axisKey === 'enabled') {
        return diagSvg([h('circle', { key: 'a', cx: 12, cy: 12, r: 9 }), h('path', { key: 'b', d: 'M12 7v5l3 2' })]);
      }
      if (axisKey === 'capability') {
        return diagSvg([h('path', { key: 'a', d: 'M4 5h16v14H4z' }),
          h('path', { key: 'b', d: 'M8 9h8M8 12.5h5M8 16h7' })]);
      }
      if (axisKey === 'dependency') {
        return diagSvg([h('circle', { key: 'a', cx: 12, cy: 12, r: 4 }),
          h('path', { key: 'b', d: 'M12 3v3M5.6 5.6l2.1 2.1M3 12h3M5.6 18.4l2.1-2.1M12 18v3M18.4 18.4l-2.1-2.1M18 12h3M18.4 5.6l-2.1 2.1' })]);
      }
      return diagSvg([h('path', { key: 'a', d: 'M12 3 20 7v5c0 4.5-3.2 7.5-8 9-4.8-1.5-8-4.5-8-9V7l8-4Z' }),
        h('path', { key: 'b', d: 'M9 12h6' })]);
    }
    function diagNodeIcon(nodeId) {
      if (nodeId === 'agent') {
        return diagSvg([h('path', { key: 'a', d: 'M12 3 14 8l5-2-2 5 4 3-5 1-1 5-3-4-5 2 2-5-4-3 5-1 2-5Z' }),
          h('circle', { key: 'b', cx: 12, cy: 12, r: 2 })]);
      }
      if (nodeId === 'controller') {
        return diagSvg([h('rect', { key: 'a', x: 4, y: 4, width: 16, height: 16, rx: 3 }),
          h('path', { key: 'b', d: 'M8 9h8M8 13h5M8 17h8' })]);
      }
      if (nodeId === 'interface') {
        return diagSvg([h('path', { key: 'a', d: 'M8 8 4 12l4 4M16 8l4 4-4 4M14 5l-4 14' })]);
      }
      if (nodeId === 'backend') {
        return diagSvg([h('rect', { key: 'a', x: 3, y: 4, width: 18, height: 13, rx: 2 }),
          h('path', { key: 'b', d: 'M8 21h8M12 17v4M7 9h4M7 12h8' })]);
      }
      return diagSvg([h('circle', { key: 'a', cx: 12, cy: 12, r: 8 }),
        h('path', { key: 'b', d: 'M4 12h16M12 4a13 13 0 0 1 0 16M12 4a13 13 0 0 0 0 16' })]);
    }

    /**
     * A Host readiness `checkedAt` (ms number, numeric string or ISO string) as an ISO string, or
     * `''` when the value cannot be parsed. Timestamps are never invented: an unusable value shows
     * as `--:--:--` instead of the current clock.
     */
    function diagIsoAt(value) {
      if (value === null || value === undefined || value === '') return '';
      const numeric = typeof value === 'number' ? value : (/^\d{6,}$/u.test(String(value)) ? Number(value) : null);
      const at = numeric === null ? new Date(String(value)) : new Date(numeric);
      return Number.isNaN(at.getTime()) ? '' : at.toISOString();
    }
    /** `HH:MM:SS` for the local clock; `--:--:--` when the timestamp is missing or unparseable. */
    function diagClock(iso) {
      const at = new Date(String(iso || ''));
      if (!iso || Number.isNaN(at.getTime())) return '--:--:--';
      const pad = (value) => String(value).padStart(2, '0');
      return pad(at.getHours()) + ':' + pad(at.getMinutes()) + ':' + pad(at.getSeconds());
    }
    /**
     * The machine-readable shape of a non-ready node: the Host's own reason code when it sent one
     * (`no-target`, `executable-missing`, `provider-not-selected`, …), else `<axis>-<status>`.
     */
    function diagReasonCode(axisKey, axis) {
      const reason = axis && axis.reason ? String(axis.reason).trim() : '';
      if (/^[a-z][a-z0-9-]{1,}$/iu.test(reason)) return reason;
      return axisKey + '-' + ((axis && axis.status) || 'not-probed');
    }
    /** What a node says under its name: the Host's reason code, else the axis status text. */
    function diagStatusText(axisKey, axis) {
      const reason = axis && axis.reason ? String(axis.reason).trim() : '';
      if (/^[a-z][a-z0-9-]{1,}$/iu.test(reason)) return reason;
      if (axis && axis.status) return axisText(axisKey, axis.status);
      return '未探测';
    }

    /* ---- Provider diagnostics: one real Host run (NDJSON) → five states ------------------ */

    /**
     * 五态：本页所有节点/边只说这五个词，且只由 Host 的 stage 事件决定。
     *
     * 中文按英语状态本身直译，**不用**「待处理」这类动作语气：`WARN` 是本次 run 已经得出的
     * 结论（后面紧跟 `provider-mismatch`、`executable-missing` 这类原因码），写成「待处理」
     * 会被读成「还没点开始诊断」。还没跑出结论的那一屏另有独立说法（`待诊断` / `诊断未完成`），
     * 见 `diagRunlessText`，与五态不共用词。
     */
    const DIAG_STATES = ['PASS', 'WARN', 'FAIL', 'SKIPPED', 'UNKNOWN'];
    const DIAG_STATE_TEXT = { PASS: '正常', WARN: '警告', FAIL: '异常', SKIPPED: '跳过', UNKNOWN: '未知' };
    const DIAG_STAGE_IDS = ['1', '2', '3', '4', '5'];
    const DIAG_RUN_ROWS = 8;
    /** 能力就绪的检查项最多显示三行；每张卡片都按三行占位（悬停看全部）。 */
    const DIAG_CHECK_LINES = 3;
    /** 最近一次 run，按 envId/providerId 保留：重进诊断页显示它，但不重放动画、不自动重跑。 */
    const DIAG_RUNS = new Map();
    const diagRunKey = (groupId, providerId) => (groupId || '') + '/' + (providerId || '');
    /**
     * 五态在界面上**只写中文**：大写状态码是给调用方 agent 的，留在 `data-uts-*-state` 属性与
     * NDJSON 里，不挤进可见文案。没有中文的非五态值（如事件流的 `INFO`）原样返回，不编造。
     */
    function diagStateLabel(state) {
      const key = String(state || '').toUpperCase();
      return DIAG_STATE_TEXT[key] || String(state || '');
    }
    /**
     * 还没有 run 结果时的说法，**不是第六个状态**，只是「本轮还没有结论」：
     * `待诊断` = 这一屏还没跑过任何 run；`诊断未完成` = 跑过但没拿到结果（错误另起一行说明）。
     * 有结论时返回空串，调用方回落到五态文案。这样「没开始」和「已经诊断出问题」用词不同，
     * 不会再把 `WARN · provider-mismatch` 读成「等你操作」。
     */
    function diagRunlessText(run) {
      const current = run || {};
      if ((current.events || []).length) return '';
      if (current.phase === 'running') return '';
      return current.error ? '诊断未完成' : '待诊断';
    }

    /**
     * 状态码的中英对照：**英文码是 Host 的机器契约**（`data-uts-*`、NDJSON、工具返回值里一律
     * 保持原样，agent 直接读），**中文只给前端客户看**。界面上渲染成 `中文（english-code）`，
     * 两种写法同时在场：人读得懂，agent 也解析得到。
     *
     * 收录范围 = 诊断页可能出现的一切码：① `integration/diagnose.js` 五阶段的原因；
     * ② 就绪六轴来自 `core/readiness.js` / `integration/cross-environment.js` 的原因；
     * ③ 页面自身造的两个（`no-run`、`run-in-progress`）。工具级错误码（`index.js` 里的
     * `reason`）不进这张表——它们不出现在本页。
     *
     * 表没收录的码**不猜**：原样显示英文；`tool-call-*`、`stage-<n>` 这两个动态族按前缀兜底。
     * 词表与 `docs/diagnose-reason-codes.md` 必须逐条一致，由
     * `tests/contracts/diagnose-status-text.test.mjs` 强制。
     */
    const DIAG_REASON_ZH = {
      // ① 诊断 run 的五个阶段
      'scope-unresolved': '无法确定当前作用域（不知道要查哪个工作区）',
      'registration-unreadable': '读取工具注册信息失败',
      'registration-broken': '工具声明与实际注册对不上',
      'tool-call-not-attempted': '没能发起工具调用',
      'tool-call-failed': '工具调用失败',
      'tool-not-admitted': '本作用域未放行这些工具',
      'config-invalid': '宿主配置无效',
      'adapter-unresolved': '没取到该运行环境的执行适配器',
      'no-runtime-entry': '插件还没建立运行时入口',
      'busy': '插件正在处理别的操作，稍后再试',
      'browser-not-running': '浏览器未运行',
      'provider-mismatch': '实际在跑的浏览器与所选运行环境不一致',
      'cdp-protocol-error': '浏览器调试协议返回错误',
      'cancelled': '本轮检查已被取消',
      'executable-missing': '没找到该浏览器的可执行文件',
      'identity-mismatch': '启动起来的浏览器不是所选的那一个',
      'identity-unverified': '拿不到浏览器版本信息，无法确认身份',
      'blocked-by-provider-mismatch': '上游运行环境不一致，这一段没执行',
      'blocked-by-stage-1': '第 1 段失败，这一段没执行',
      'blocked-by-stage-3': '第 3 段未通过，这一段没执行',
      'stage-timeout': '这一段超时，没拿到结果',
      'target-list-failed': '读取标签页列表失败',
      'no-bound-target': '还没有绑定调试目标',
      'readonly-eval-failed': '只读求值失败（在页面里跑只读脚本出错）',
      'readonly-eval-unexpected': '只读求值的结果不是预期的 1',
      'target-not-in-list': '目标已不在标签页列表里（可能已被关闭）',
      'capability-partial': '部分能力不可用',
      // ② 就绪六轴（readiness / cross-environment / 运行环境自身）
      'not-probed': '未探测',
      'probe-failed': '探测失败',
      'environment-disabled': '环境总开关已关闭',
      'adapter-not-registered': '该环境还没接入适配器',
      'no-capabilities': '没有上报能力清单',
      'no-runtime': '宿主里还没有这个环境的运行时',
      'no-target': '还没有目标',
      'target-not-bound': '目标未绑定',
      'target-unbound': '目标已解绑',
      'target-gone': '调试目标已消失',
      'cdp-not-attached': '还没连上浏览器调试端口',
      'collector-missing': '缺少网络采集器',
      'frame-source-missing': '没有可用的帧来源',
      'input-unsupported': '该浏览器后端不支持模拟输入',
      'provider-not-selected': '未选择该运行环境',
      'provider-disabled': '该运行环境已停用',
      'provider-driver-pending': '该运行环境的驱动待接入',
      'provider-not-implemented': '该运行环境尚未实现',
      'provider-dependency-not-verified': '还没验证该运行环境的依赖',
      'provider-missing': '没有这个运行环境',
      'capability-disabled': '该能力已关闭',
      'capability-unknown': '未知的能力名',
      'cold': '浏览器还没启动',
      'host-idle-no-transport': '宿主空闲，没有可用的传输通道',
      'session-missing': '调试会话已不存在',
      'no-session': '没有调试会话',
      'aborted': '已中止',
      // core/contracts.js 的 WEB_PROVIDER_REASONS（驱动拒绝 / 就绪 / 工具错误共用同一批拼写）
      'driver-pending': '该运行环境的驱动待接入',
      'unknown-provider': '没有这个运行环境',
      'provider-unsupported': '该运行环境不受支持',
      'override-invalid': '指定的浏览器路径不可用',
      // ③ 页面自身造的状态（不是 Host 的码）
      'no-run': '还没有诊断结果',
      'run-in-progress': '诊断进行中',
    };
    /**
     * 术语对照：这些词在**界面上一律用中文**，英文原样只留在 `data-uts-*`、NDJSON 和代码里
     * （agent 与排障用）。翻译按上下文取用户能看懂的词，不做字对字直译。
     */
    const DIAG_TERM_ZH = {
      'run': '本轮',
      'Host': '宿主',
      'Failed to fetch': '连不上宿主（请求失败）',
      'stage-start': '阶段开始',
      'stage-end': '阶段结束',
      'readonly-eval': '只读求值',
      'target-list': '目标列表',
      'snapshot': '快照',
      'screenshot': '截图',
      'computed-style': '计算样式',
      'network-read': '网络记录',
      'pass': '通过',
      'fail': '失败',
      'skip': '跳过',
      'ok': '通过',
      'PASS': '正常',
    };
    /** 术语 / 原因码 / 检查项 → 中文；都没有译文时原样返回英文。 */
    function diagTermLabel(term) {
      const key = String(term || '').trim();
      if (!key) return '';
      if (Object.prototype.hasOwnProperty.call(DIAG_TERM_ZH, key)) return DIAG_TERM_ZH[key];
      return diagReasonLabel(key);
    }
    /** 码 → 中文；动态族按前缀兜底，未收录返回空串（调用方原样显示英文）。 */
    function diagReasonZh(code) {
      const key = String(code || '').trim();
      if (!key) return '';
      if (Object.prototype.hasOwnProperty.call(DIAG_REASON_ZH, key)) return DIAG_REASON_ZH[key];
      if (/^tool-call-/u.test(key)) return '工具调用失败';
      if (/^stage-\d$/u.test(key)) return '该段没有给出原因';
      return '';
    }
    /**
     * 原因码在界面上**只写中文**；英文原码是给调用方 agent 的，留在 `data-uts-stage-reason` /
     * `data-uts-axis-reason-code` / `data-uts-event-reason` 与 NDJSON 的 `reason` 里。
     * 没有译文时原样显示英文码，绝不编造中文。
     */
    function diagReasonLabel(code) {
      const key = String(code || '').trim();
      if (!key) return '';
      return diagReasonZh(key) || key;
    }
    /* ---- Diagnostics overlay (frame-wide `shell.overlay`) ---------------------------------- */
    // The diagnostics page used to live inside the settings modal, which is far too narrow for the
    // five-node chain. It now opens in its own frame-wide overlay; the settings page only keeps the
    // entry buttons. State is module-level so both entry points live in the same bundle.
    const diagOverlayStore = {
      state: { open: false, groupId: '', providerId: '', trigger: null },
      listeners: new Set(),
    };
    function diagOverlayGet() { return diagOverlayStore.state; }
    function diagOverlaySet(next) {
      diagOverlayStore.state = Object.assign({}, diagOverlayStore.state, next);
      for (const listener of Array.from(diagOverlayStore.listeners)) {
        try { listener(); } catch { /* ignore */ }
      }
    }
    function diagOverlaySubscribe(listener) {
      diagOverlayStore.listeners.add(listener);
      return () => { diagOverlayStore.listeners.delete(listener); };
    }
    function openDiagnostics(groupId, providerId, trigger) {
      // Prefer the element that actually opened the overlay (the card button): a keyboard/secondary
      // activation may leave document.activeElement on <body>, and focus must come back to the card.
      const active = trigger || (typeof document !== 'undefined' ? document.activeElement : null);
      diagOverlaySet({ open: true, groupId: groupId || '', providerId: providerId || '', trigger: active || null });
    }
    function closeDiagnostics() {
      diagOverlaySet({ open: false });
    }
    function useDiagnosticsOverlay() {
      if (typeof React.useSyncExternalStore === 'function') {
        return React.useSyncExternalStore(diagOverlaySubscribe, diagOverlayGet, diagOverlayGet);
      }
      const [state, setState] = React.useState(diagOverlayGet);
      React.useEffect(() => diagOverlaySubscribe(() => setState(diagOverlayGet())), []);
      return state;
    }

    const diagEmptyRun = (providerId) => ({
      runId: '', provider: providerId || '', mode: '', phase: 'idle',
      events: [], stages: {}, stagePhase: {}, axes: null, overall: null,
      actualCalls: [], sideEffects: [], configRevision: null,
      startedAt: null, finishedAt: null, error: '',
    });

    function diagRequestId() {
      try {
        if (typeof crypto !== 'undefined' && typeof crypto.randomUUID === 'function') return crypto.randomUUID();
      } catch { /* fall through */ }
      return 'diag-' + Date.now().toString(36) + '-' + Math.random().toString(36).slice(2, 10);
    }

    /**
     * Start one real diagnosis run and stream its NDJSON events.
     *
     * `observe` (default) never starts a browser; `start` is only used after the user explicitly
     * asks for it. The caller owns the AbortController: leaving the page aborts the stream (the
     * Host then stops the run — it does not keep executing behind a closed page).
     */
    async function startDiagnoseRun({ provider, mode, signal, onEvent }) {
      const response = await fetch(HOST_BASE + '/diagnose', {
        method: 'POST',
        credentials: 'same-origin',
        cache: 'no-store',
        // `/diagnose` is a scoped-GUI surface (an unscoped call is 401 by design). The settings page
        // works on the global/default scope, so it asks for `unassigned` explicitly and never lets
        // the Host guess with `recent`.
        headers: {
          'content-type': 'application/json',
          'X-UI-Testing-Scope-Version': SCOPE_VERSION,
          'X-UI-Testing-Scope': 'unassigned',
        },
        body: JSON.stringify({ provider: provider || undefined, mode: mode || 'observe', requestId: diagRequestId() }),
        signal,
      });
      if (!response.ok) {
        const payload = await response.json().catch(() => ({}));
        const error = new Error(payload.error || ('诊断请求失败：' + response.status));
        error.code = payload.code || 'DIAGNOSE_REQUEST_FAILED';
        error.status = response.status;
        throw error;
      }
      if (!response.body || typeof response.body.getReader !== 'function') {
        throw Object.assign(new Error('诊断响应不是可读流'), { code: 'DIAGNOSE_STREAM_UNAVAILABLE' });
      }
      const reader = response.body.getReader();
      const decoder = new TextDecoder();
      let buffer = '';
      for (;;) {
        const { done, value } = await reader.read();
        if (done) break;
        buffer += decoder.decode(value, { stream: true });
        let index;
        while ((index = buffer.indexOf('\n')) >= 0) {
          const line = buffer.slice(0, index).trim();
          buffer = buffer.slice(index + 1);
          if (!line) continue;
          let event;
          try { event = JSON.parse(line); } catch { continue; }
          if (event && typeof event === 'object' && typeof onEvent === 'function') onEvent(event);
        }
      }
      return true;
    }

    /** Fold one NDJSON event into the run state (pure; used by both live streaming and replay). */
    function diagApplyEvent(run, event) {
      const next = Object.assign({}, run);
      next.events = (run.events || []).concat([event]);
      next.stagePhase = Object.assign({}, run.stagePhase);
      next.stages = Object.assign({}, run.stages);
      if (event.type === 'run-start') {
        next.runId = event.runId || '';
        next.provider = event.provider || run.provider;
        next.mode = event.mode || run.mode;
        next.phase = 'running';
        next.startedAt = event.startedAt || null;
        next.configRevision = event.configRevision ?? null;
        next.error = '';
      } else if (event.type === 'stage-start') {
        next.stagePhase[event.stageId] = 'running';
      } else if (event.type === 'stage-end') {
        next.stagePhase[event.stageId] = 'finished';
        next.stages[event.stageId] = {
          stageId: event.stageId,
          phase: 'finished',
          status: DIAG_STATES.includes(event.status) ? event.status : 'UNKNOWN',
          reason: event.reason || null,
          blockedBy: event.blockedBy ?? null,
          startedAt: event.startedAt ?? null,
          finishedAt: event.finishedAt ?? null,
          durationMs: event.durationMs === undefined ? null : event.durationMs,
          checks: Array.isArray(event.checks) ? event.checks : [],
          evidenceRef: event.evidenceRef || null,
          seq: event.seq,
        };
      } else if (event.type === 'run-end') {
        next.phase = 'finished';
        next.finishedAt = event.finishedAt || null;
        next.axes = event.axes || null;
        next.overall = event.overall || null;
        next.actualCalls = Array.isArray(event.actualCalls) ? event.actualCalls : [];
        next.sideEffects = Array.isArray(event.sideEffects) ? event.sideEffects : [];
        next.stages = Object.assign({}, next.stages, event.stages || {});
        next.stagePhase = Object.assign({}, next.stagePhase);
        for (const stageId of DIAG_STAGE_IDS) next.stagePhase[stageId] = 'finished';
      }
      return next;
    }

    /**
     * Node/edge model for one run.
     *
     * Node state = that stage's own status (UNKNOWN until the stage reports). An edge is decided by
     * **both** ends: a FAIL above stops the flow (FAIL), a skipped downstream segment is SKIPPED, and
     * anything still unknown keeps the edge UNKNOWN. Nothing here can turn green without a stage
     * that actually finished PASS.
     */
    /**
     * 诊断日志左侧的「操作名」：界面写中文，`data-uts-event-operation` 仍保留英文 id
     * （`run-start` / `stage-N` / `run-end`），agent 与排障不受影响。
     */
    function diagOperationLabel(operation) {
      const key = String(operation || '');
      if (key === 'run-start') return '本轮开始';
      if (key === 'run-end') return '本轮结束';
      const stage = /^stage-(\d+)$/u.exec(key);
      return stage ? '第 ' + stage[1] + ' 段' : key;
    }

    /** 调试节点的完整信息（悬停提示）：角色/名称、职责、状态、原因码、阻塞与耗时。 */
    function diagNodeTitle(node, statusText, stage, phase) {
      return [
        String(node.role || '') + ' · ' + String(node.name || ''),
        String(node.sub || ''),
        '状态：' + String(statusText || ''),
        stage && stage.reason ? '原因码：' + String(stage.reason) : '',
        stage && stage.blockedBy !== null && stage.blockedBy !== undefined ? '阻塞于阶段 ' + String(stage.blockedBy) : '',
        stage && stage.durationMs !== null && stage.durationMs !== undefined ? '耗时 ' + String(stage.durationMs) + 'ms' : '',
        phase === 'running' ? '本段正在检查' : '',
      ].filter(Boolean).join('\n');
    }

    function diagRunModel(run, target) {
      const current = run || diagEmptyRun(target && target.id);
      const stages = current.stages || {};
      const stageOf = (id) => stages[id] || null;
      const stateOf = (id) => (stageOf(id) ? stageOf(id).status : 'UNKNOWN');
      const chain = (target && target.chain) || {};
      const interfaceName = chain.communication ? String(chain.communication) : 'CDP';
      const interfaceNameWithSuffix = /接口$/.test(interfaceName) ? interfaceName : interfaceName + '接口';
      const backendName = chain.backend ? String(chain.backend) : 'Chromium DevTools';
      const targetName = target && (target.name || target.id) ? String(target.name || target.id) : 'Chrome';
      const nodeSubs = {
        1: '检查宿主集成、工具注册及调用通道',
        2: '检查插件 Core、配置和调度能力',
        3: '执行通信接口探测',
        4: '检查执行后端及依赖可用性',
        5: '查询目标列表，验证目标绑定与连接状态',
      };
      const nodes = [
        { index: 1, id: 'agent', name: 'DeepSeekHarness', role: 'AI代理', sub: nodeSubs[1], state: stateOf('1'), stage: stageOf('1') },
        { index: 2, id: 'controller', name: 'dsh-agent-team-ui-testing', role: '调试控制器', sub: nodeSubs[2], state: stateOf('2'), stage: stageOf('2') },
        { index: 3, id: 'interface', name: interfaceNameWithSuffix, role: '通信接口', sub: nodeSubs[3], state: stateOf('3'), stage: stageOf('3') },
        { index: 4, id: 'backend', name: backendName, role: '调试后端', sub: nodeSubs[4], state: stateOf('4'), stage: stageOf('4') },
        { index: 5, id: 'target', name: targetName + '页面', role: '目标运行环境', sub: nodeSubs[5], state: stateOf('5'), stage: stageOf('5') },
      ];
      const edgeState = (up, down) => {
        if (up === 'FAIL' || down === 'FAIL') return 'FAIL';
        if (down === 'SKIPPED') return 'SKIPPED';
        if (up === 'UNKNOWN' || down === 'UNKNOWN') return 'UNKNOWN';
        if (up === 'WARN' || down === 'WARN') return 'WARN';
        return 'PASS';
      };
      // A dot only runs on a segment whose downstream stage really finished PASS in this run.
      const liveEdge = (downIndex) => {
        const stage = stageOf(String(downIndex));
        return Boolean(stage && stage.status === 'PASS' && (current.stagePhase || {})[String(downIndex)] === 'finished');
      };
      const edges = [
        { index: 1, state: edgeState(nodes[0].state, nodes[1].state), label: '指令', live: liveEdge(2) },
        { index: 2, state: edgeState(nodes[1].state, nodes[2].state), label: '标准化命令', live: liveEdge(3) },
        { index: 3, state: edgeState(nodes[2].state, nodes[3].state), label: interfaceName + ' 通信', live: liveEdge(4) },
        { index: 4, state: edgeState(nodes[3].state, nodes[4].state), label: liveEdge(5) ? interfaceName + ' 会话正常' : '等待目标绑定', live: liveEdge(5) },
      ];
      for (const edge of edges) if (edge.state !== 'PASS') edge.live = false;
      const duties = nodes.map((node) => ({ node: node.id, name: node.name, text: DIAG_DUTY_TEXT[node.id] || '' }));
      const overall = current.overall
        ? { status: current.overall.status || 'UNKNOWN', reason: current.overall.reason || '' }
        : { status: current.phase === 'running' ? 'UNKNOWN' : 'UNKNOWN', reason: current.phase === 'running' ? 'run-in-progress' : 'no-run' };
      return { run: current, nodes, edges, duties, overall, stageOf };
    }

    /** Event rows: one per stage-end plus the run markers, newest first, bounded to 8. */
    function diagRunRows(run) {
      const current = run || diagEmptyRun('');
      const rows = [];
      for (const event of current.events || []) {
        if (event.type === 'run-start') {
          rows.push({ kind: 'run-start', seq: event.seq, at: event.startedAt || null, operation: 'run-start', runId: event.runId || '', status: 'UNKNOWN', reason: null, blockedBy: null, durationMs: null, evidenceRef: null });
        } else if (event.type === 'stage-end') {
          rows.push({
            kind: 'stage', stageId: event.stageId, seq: event.seq, at: event.finishedAt || event.startedAt || null,
            operation: 'stage-' + event.stageId, runId: event.runId || '',
            status: DIAG_STATES.includes(event.status) ? event.status : 'UNKNOWN',
            reason: event.reason || null, blockedBy: event.blockedBy ?? null,
            durationMs: event.durationMs === undefined ? null : event.durationMs,
            evidenceRef: event.evidenceRef || null,
          });
        } else if (event.type === 'run-end') {
          rows.push({ kind: 'run-end', seq: event.seq, at: event.finishedAt || null, operation: 'run-end', runId: event.runId || '', status: (event.overall && event.overall.status) || 'UNKNOWN', reason: (event.overall && event.overall.reason) || null, blockedBy: null, durationMs: event.durationMs === undefined ? null : event.durationMs, evidenceRef: null });
        }
      }
      return rows
        .sort((left, right) => (right.seq || 0) - (left.seq || 0))
        .slice(0, DIAG_RUN_ROWS);
    }

    /**
     * Normalize the Host readiness payload (`{checkedAt, environments:[...]}` or a map keyed by
     * environment id). Each axis may be a bare status or `{status, reason}`; missing axes stay
     * absent so the page can say "not probed" instead of inventing a value.
     */
    /**
     * Read the six axes out of one Host readiness entry (environment-level or provider-level).
     * The Host returns a nested `axes` object (M4 contract); older/defensive shapes may still be
     * flat, so the nested value is read first and the flat field is the fallback.
     */
    function axesOfHostEntry(entry) {
      const axes = {};
      if (!entry || typeof entry !== 'object') return axes;
      for (const axis of AXIS_ORDER) {
        const rawValue = entry.axes && entry.axes[axis] !== undefined
          ? entry.axes[axis]
          : entry[axis];
        if (rawValue === undefined || rawValue === null) continue;
        if (typeof rawValue === 'object') {
          const status = rawValue.status === undefined || rawValue.status === null ? '' : String(rawValue.status);
          if (!status) continue;
          // A13: keep the *evidence* the Host measured, not just a status word. Dropping
          // target/evidence/expiresAt here made "which capability is missing / which target was
          // probed / when" unanswerable in the page even though the Host had measured it.
          axes[axis] = {
            status,
            reason: rawValue.reason ? String(rawValue.reason) : '',
            checkedAt: Number.isFinite(rawValue.checkedAt) ? rawValue.checkedAt : null,
            expiresAt: Number.isFinite(rawValue.expiresAt) ? rawValue.expiresAt : null,
            targetId: rawValue.target && typeof rawValue.target === 'object' && rawValue.target.targetId
              ? String(rawValue.target.targetId)
              : '',
            evidenceKind: rawValue.evidence && typeof rawValue.evidence === 'object' && rawValue.evidence.kind
              ? String(rawValue.evidence.kind)
              : '',
            checks: rawValue.evidence && typeof rawValue.evidence === 'object'
              && rawValue.evidence.checks && typeof rawValue.evidence.checks === 'object'
              ? rawValue.evidence.checks
              : null,
          };
        } else {
          axes[axis] = { status: String(rawValue), reason: '', checkedAt: null, expiresAt: null, targetId: '', evidenceKind: '', checks: null };
        }
      }
      return axes;
    }

    function normalizeReadiness(readiness) {
      const map = {};
      if (!readiness || typeof readiness !== 'object') return map;
      const raw = readiness.environments;
      let list = null;
      if (Array.isArray(raw)) list = raw;
      else if (raw && typeof raw === 'object') list = Object.keys(raw).map((id) => Object.assign({ environment: id }, raw[id]));
      if (!list) return map;
      for (const entry of list) {
        if (!entry || typeof entry !== 'object') continue;
        const id = String(entry.environment || entry.id || entry.env || '');
        if (!id) continue;
        const axes = axesOfHostEntry(entry);
        // Slice ② also reports per-provider axes (`readiness.environments[web].providers.<id>.axes`).
        // Each card reads its own provider's result instead of sharing Chrome's connection/target/
        // capability axes — a disabled provider is therefore not rendered as "ready".
        const providers = {};
        const rawProviders = entry.providers && typeof entry.providers === 'object' ? entry.providers : null;
        if (rawProviders) {
          for (const [providerId, providerEntry] of Object.entries(rawProviders)) {
            if (!providerEntry || typeof providerEntry !== 'object') continue;
            providers[providerId] = {
              axes: axesOfHostEntry(providerEntry),
              checkedAt: String(providerEntry.checkedAt || entry.checkedAt || readiness.checkedAt || ''),
              reason: providerEntry.reason ? String(providerEntry.reason) : '',
            };
          }
        }
        map[id] = {
          axes,
          providers,
          checkedAt: String(entry.checkedAt || readiness.checkedAt || ''),
          reason: entry.reason ? String(entry.reason) : '',
        };
      }
      return map;
    }

    /** Static engineering support, used only when the Host sends no support axis. */
    function staticSupportOf(groupId) {
      const group = TARGET_ENV_GROUPS.find((item) => item.id === groupId);
      if (!group) return 'planned';
      if (group.targets.some((target) => target.state === 'supported')) return 'supported';
      if (group.targets.some((target) => target.state === 'unsupported')) return 'unsupported';
      return 'planned';
    }

    /** `true`/`false` from the Host config, or `null` when the config carries no environment map. */
    function enabledFromConfig(config, envId) {
      const envs = config && config.global && config.global.environments;
      if (!envs || typeof envs !== 'object') return null;
      const entry = envs[envId];
      return Boolean(entry && entry.enabled === true);
    }

    /**
     * Per-provider switch values straight from the Host config.
     *
     * Returns `null` when the config carries no provider map at all (old Host / unreadable config),
     * so the page can say "unknown" instead of pretending the switch is off. The map is the single
     * source of truth: closing the target-environment master switch never rewrites these values.
     */
    function providersFromConfig(config, envId) {
      const envs = config && config.global && config.global.environments;
      const entry = envs && typeof envs === 'object' ? envs[envId] : null;
      const providers = entry && typeof entry.providers === 'object' && entry.providers ? entry.providers : null;
      if (!providers) return null;
      const out = {};
      for (const [providerId, value] of Object.entries(providers)) {
        out[providerId] = Boolean(value && value.enabled === true);
      }
      return out;
    }

    /**
     * The execution provider the Host resolved for this scope. Read from `resolved.provider`, never
     * inferred from the checkboxes: the switch says "may use", this says "will use".
     */
    function currentProviderFromState(state) {
      const resolved = state && state.resolved && typeof state.resolved === 'object' ? state.resolved : null;
      return resolved && typeof resolved.provider === 'string' ? resolved.provider : '';
    }

    /**
     * Six axes for one provider card, read from `readiness.environments[env].providers.<id>.axes`.
     * When the Host reports nothing for that provider, every axis stays `not-probed` with a reason —
     * a card never borrows another provider's connection/target/capability evidence.
     */
    function providerAxes(state, envId, providerId) {
      const entry = state && state.readiness ? state.readiness[envId] : null;
      const providerEntry = entry && entry.providers ? entry.providers[providerId] : null;
      const hostAxes = providerEntry && providerEntry.axes ? providerEntry.axes : null;
      const configLoaded = Boolean(state && state.revision !== null && !state.error);
      return AXIS_ORDER.map((axis) => {
        if (axis === 'enabled') {
          if (configLoaded) {
            const providers = providersFromConfig(state.config, envId);
            if (providers === null) {
              return { axis, status: 'not-probed', reason: '宿主配置未包含运行环境清单', source: 'unavailable' };
            }
            return providers[providerId] === true
              ? { axis, status: 'true', reason: '宿主配置已启用该运行环境', source: 'host' }
              : { axis, status: 'false', reason: '宿主配置未启用该运行环境', source: 'host' };
          }
          return { axis, status: 'not-probed', reason: '宿主配置不可用，未读取到该运行环境的启用状态', source: 'unavailable' };
        }
        const host = hostAxes ? hostAxes[axis] : null;
        if (host && host.status) {
          return {
            axis,
            status: host.status,
            reason: host.reason || '来自宿主就绪结果',
            source: 'host',
            checkedAt: host.checkedAt ?? null,
            expiresAt: host.expiresAt ?? null,
            targetId: host.targetId || '',
            evidenceKind: host.evidenceKind || '',
            checks: host.checks || null,
          };
        }
        return { axis, status: 'not-probed', reason: '宿主未提供该运行环境的探测结果', source: 'unavailable' };
      });
    }

    /**
     * Six independent axes for one environment. Nothing is merged into a single "valid" flag:
     * unsupported, disabled and not-probed stay distinguishable, and a missing Host answer is
     * reported as not-probed with a reason rather than a ready state.
     */
    function environmentAxes(state, groupId) {
      const entry = state && state.readiness ? state.readiness[groupId] : null;
      const hostAxes = entry && entry.axes ? entry.axes : {};
      const configLoaded = Boolean(state && state.revision !== null && !state.error);
      return AXIS_ORDER.map((axis) => {
        // `enabled` is the user's saved intent: the Host config revision wins over a readiness
        // snapshot, so a successful PUT is visible immediately (the write response has no readiness).
        if (axis === 'enabled') {
          if (configLoaded) {
            const enabled = enabledFromConfig(state.config, groupId);
            if (enabled === null) {
              return { axis, status: 'not-probed', reason: '宿主配置未包含环境策略', source: 'unavailable' };
            }
            return {
              axis,
              status: enabled ? 'true' : 'false',
              reason: enabled ? '宿主配置已启用该环境' : '宿主配置未启用该环境',
              source: 'host',
            };
          }
          if (state && state.error) {
            return { axis, status: 'not-probed', reason: '宿主配置读取失败，无法确认用户启用状态', source: 'unavailable' };
          }
          const hostEnabled = hostAxes.enabled;
          if (hostEnabled && hostEnabled.status) {
            return { axis, status: hostEnabled.status, reason: hostEnabled.reason || '来自宿主就绪结果', source: 'host' };
          }
          return { axis, status: 'not-probed', reason: '宿主配置不可用，未读取到用户启用状态', source: 'unavailable' };
        }
        const host = hostAxes[axis];
        if (host && host.status) {
          // Carry the measured detail through to the DOM: which target was probed, when it was
          // checked, and (for the capability axis) which per-capability checks passed (A13).
          return {
            axis,
            status: host.status,
            reason: host.reason || '来自宿主就绪结果',
            source: 'host',
            checkedAt: host.checkedAt ?? null,
            expiresAt: host.expiresAt ?? null,
            targetId: host.targetId || '',
            evidenceKind: host.evidenceKind || '',
            checks: host.checks || null,
          };
        }
        if (axis === 'support') {
          return { axis, status: staticSupportOf(groupId), reason: '静态候选清单（宿主未提供 support 探测）', source: 'static' };
        }
        return { axis, status: 'not-probed', reason: '宿主未提供该轴的探测结果', source: 'unavailable' };
      });
    }

    const EMPTY_HOST_CONFIG = Object.freeze({
      loading: true, error: '', revision: null, config: null, resolved: null, readiness: {}, checkedAt: '',
      // Local observation time of the last *successful* read (ms). `checkedAt` is the Host's probe
      // time; this one answers "how long ago did this page last hear from the Host".
      lastReadAt: 0,
    });

    /** Adopt one Host config payload; a payload without a numeric revision is a failed read. */
    function mergeHostConfig(previous, payload) {
      const revision = payload && typeof payload.revision === 'number' ? payload.revision : null;
      if (revision === null) {
        return Object.assign({}, previous, {
          loading: false,
          error: '宿主未提供配置接口（响应缺少 revision）',
        });
      }
      const readiness = payload.readiness !== undefined ? normalizeReadiness(payload.readiness) : previous.readiness;
      const checkedAt = payload.readiness && payload.readiness.checkedAt
        ? String(payload.readiness.checkedAt)
        : previous.checkedAt;
      return {
        loading: false,
        error: '',
        revision,
        config: payload.config !== undefined ? payload.config : previous.config,
        resolved: payload.resolved !== undefined ? payload.resolved : previous.resolved,
        readiness,
        checkedAt,
        lastReadAt: previous.lastReadAt || 0,
      };
    }

    /**
     * 宿主配置类错误的英文原因 → 中文。宿主返回的是机器可读英文（`environment android is
     * planned and cannot be selected in v1` 等），直接上屏对用户没有信息量；这里按已知模式翻译，
     * 未识别的原样保留（不猜），原文仍留在悬停提示里。
     */
    function configErrorText(message) {
      const raw = String(message || '').trim();
      if (!raw) return '';
      let match = /^environment\s+(\S+)\s+is planned and cannot be selected in v1/iu.exec(raw);
      if (match) return 'v1 还不支持启用 ' + match[1] + '：该环境仍是规划中';
      match = /^environment\s+(\S+)\s+is test-only/iu.exec(raw);
      if (match) return match[1] + ' 仅供测试使用';
      match = /^unknown environment:\s*(\S+)/iu.exec(raw);
      if (match) return '没有这个目标环境：' + match[1];
      match = /^unknown provider:\s*(\S+)/iu.exec(raw);
      if (match) return '没有这个运行环境：' + match[1];
      return raw;
    }

    function hostConfigError(error) {
      const code = String((error && error.code) || '');
      if (code === 'CONFIG_TIMEOUT') return '读取宿主配置超时（' + HOST_CONFIG_TIMEOUT_MS + 'ms 内未完成）';
      if (code === 'CONFIG_CONFLICT') return '配置已被其他窗口修改（CONFIG_CONFLICT）';
      if (code === 'CONFIG_UNAVAILABLE' || (error && error.status === 404)) {
        return '宿主未提供配置接口，无法读取或保存配置';
      }
      const detail = error && error.message ? String(error.message) : '';
      // `Failed to fetch` 是浏览器原话，对用户没有信息量：说清「连不上谁」。
      if (/failed to fetch/iu.test(detail)) return '连不上宿主：请求没送到 DSH（可能已经停止运行）';
      return '读取宿主配置失败' + (detail ? '：' + detail : '');
    }

    /**
     * Read one Host config view and keep the Host revision as the only truth. `scope` is `null` on
     * the settings page (legacy/default, no scope headers) and the panel's own snapshot in the
     * panel. A failed read leaves the caller usable but exposes `error`; nothing reports ready.
     *
     * `options` is optional and every field defaults to the original single-read behaviour, so the
     * existing call sites (`useHostConfig(scope, 'session')`, `useHostConfig(null, 'global')`) are
     * unchanged:
     *   - `pollMs`  > 0 keeps re-reading on that interval while the component is mounted. A tick is
     *               skipped when the document is hidden and when a request is already in flight, so
     *               at most one GET is ever outstanding and the page is silent in the background.
     *   - `initial` seeds the very first state (the list page already holds a Host read), which is
     *               what keeps a sub-page from flashing "not probed" for one frame.
     *   - `silent`  never toggles `loading` (no spinner/blank flicker on a poll); a failed poll keeps
     *               the previous payload and only sets `error`, which the page renders as `stale`.
     */
    /**
     * 同页面配置变更总线：设置页写完配置后通知调试视图重读，避免两个面板靠轮询或等刷新才同步。
     * 订阅方只做「重新读一次」，不做本地合并——宿主 revision 仍是唯一真值。
     */
    const hostConfigBus = { listeners: new Set() };
    function publishHostConfigChange() {
      for (const listener of Array.from(hostConfigBus.listeners)) {
        try { listener(); } catch { /* 一个订阅者出错不影响其它订阅者 */ }
      }
    }
    function useHostConfigChange(listener) {
      const ref = React.useRef(listener);
      ref.current = listener;
      React.useEffect(() => {
        const handler = () => { if (typeof ref.current === 'function') ref.current(); };
        hostConfigBus.listeners.add(handler);
        return () => { hostConfigBus.listeners.delete(handler); };
      }, []);
    }

    function useHostConfig(scope, view, options) {
      const opts = options && typeof options === 'object' ? options : {};
      const pollMs = Number.isFinite(opts.pollMs) && opts.pollMs > 0 ? Number(opts.pollMs) : 0;
      const silent = opts.silent === true;
      const initial = opts.initial && typeof opts.initial === 'object' ? opts.initial : null;
      const [state, setState] = React.useState(() => (
        initial ? Object.assign({}, initial, { loading: false }) : EMPTY_HOST_CONFIG
      ));
      const stateRef = React.useRef(state);
      stateRef.current = state;
      const epochRef = React.useRef(0);
      // The in-flight marker is a request **identity**, not a boolean: a superseded request that
      // finishes late must not clear the marker of the request that replaced it (M5).
      const inFlightRef = React.useRef(0);
      const requestIdRef = React.useRef(0);
      // How many snapshots *this instance* successfully adopted. The diagnostics page uses it to
      // tell "a real fresh Host read" from the caller-supplied `initial` snapshot (M3).
      const [reads, setReads] = React.useState(0);
      const load = React.useCallback((signal) => {
        const epoch = ++epochRef.current;
        const requestId = ++requestIdRef.current;
        inFlightRef.current = requestId;
        const settle = () => { if (inFlightRef.current === requestId) inFlightRef.current = 0; };
        if (!silent) setState((current) => Object.assign({}, current, { loading: true, error: '' }));
        getHostConfig(scope, view, signal).then((payload) => {
          settle();
          if (epoch !== epochRef.current) return;
          const merged = mergeHostConfig(stateRef.current, payload);
          // `lastReadAt` is the "last complete, valid config adopted" time: a response that only
          // carries an error (e.g. no numeric revision) must not move it forward (M4).
          if (!merged.error && merged.revision !== null) merged.lastReadAt = Date.now();
          setState(merged);
          if (!merged.error && merged.revision !== null) setReads((value) => value + 1);
        }).catch((error) => {
          settle();
          if (epoch !== epochRef.current) return;
          if (error && error.name === 'AbortError') return;
          setState(Object.assign({}, stateRef.current, { loading: false, error: hostConfigError(error) }));
        });
      }, [scope, view, silent]);
      React.useEffect(() => {
        let controller = null;
        if (typeof AbortController === 'function') controller = new AbortController();
        const visible = () => !(typeof document !== 'undefined' && document.visibilityState === 'hidden');
        // The page promises "hidden means no request", so even the first read waits for visibility.
        if (!pollMs || visible()) load(controller ? controller.signal : undefined);
        let timer = null;
        if (pollMs) {
          timer = setInterval(() => {
            // Background tabs keep their data but stop asking the Host for more.
            if (!visible()) return;
            if (inFlightRef.current !== 0) return;
            load(controller ? controller.signal : undefined);
          }, pollMs);
        }
        return () => {
          if (timer !== null) clearInterval(timer);
          epochRef.current += 1;
          // Abort the current request (its own deadline timer is cleared by the request itself).
          if (controller) controller.abort();
        };
      }, [load, pollMs]);
      const reload = React.useCallback(() => load(undefined), [load]);
      const adopt = React.useCallback((payload) => {
        const next = mergeHostConfig(stateRef.current, payload);
        setState(next);
        return next;
      }, []);
      return { state, reload, adopt, reads };
    }

    /** A CAS conflict carries the latest revision: adopt it, or re-read when it does not. */
    function adoptHostConflict(hostConfig, error) {
      const payload = error && error.payload;
      if (payload && typeof payload.revision === 'number') {
        hostConfig.adopt(payload);
        // Without the full config the write response cannot settle the page: re-read it.
        if (payload.config === undefined) hostConfig.reload();
        return;
      }
      hostConfig.reload();
    }

    function readExpandedGroups() {
      try {
        const raw = window.localStorage.getItem(SETTINGS_EXPANDED_KEY);
        if (!raw) return {};
        const parsed = JSON.parse(raw);
        if (!parsed || typeof parsed !== 'object') return {};
        const next = {};
        for (const key of Object.keys(parsed)) if (parsed[key] === true) next[key] = true;
        return next;
      } catch (error) {
        return {};
      }
    }

    function writeExpandedGroups(map) {
      try {
        window.localStorage.setItem(SETTINGS_EXPANDED_KEY, JSON.stringify(map));
      } catch (error) {
        /* Storage may be unavailable (private mode / policy); in-memory state still works. */
      }
    }

    /**
     * 开关组件：受控时把变更交给调用方（例如提交 Host），非受控时保留旧的本地预览行为。
     * 未支持/未接入或 Host 配置不可用时保持禁用（灰态），避免让人以为已经可启用。
     */
    function TargetEnvSwitch(props) {
      const [on, setOn] = React.useState(props.checked === true);
      const controlled = typeof props.onChange === 'function';
      const title = props.title || (props.disabled
        ? '当前不可启用'
        : controlled ? '仅筛选当前页面显示的目标' : '前端预览：启用状态暂不保存');
      return h('label', {
        className: 'uts-switch',
        title,
        'data-uts-switch-busy': props.busy ? 'true' : 'false',
      },
        h('input', {
          type: 'checkbox',
          role: 'switch',
          className: 'uts-switch-input',
          'aria-label': props.label,
          checked: controlled ? props.checked === true : on,
          disabled: props.disabled,
          onChange: (event) => controlled ? props.onChange(event.target.checked) : setOn(event.target.checked),
        }),
        h('span', { className: 'uts-switch-track', 'aria-hidden': true }, h('span', { className: 'uts-switch-thumb' })));
    }

    /**
     * 第五节点目标卡片：名称 + 启用分开关，页脚左侧「可用」（已实现）/「未支持 · 未接入」（灰字占位）、右侧「诊断」。
     *
     * 不再显示的东西：当前使用 / 未选中标签（开关已经反映启用状态）、已实现 / 未支持 / 未接入
     * 标签（改用「可用」一枚）、接口 / 执行端（③④，在诊断页）、依赖状态（诊断页六轴之一）。
     * 不显示任何写死版本：启用状态来自 Host 配置，目标状态来自 Host 就绪结果。
     */
    function TargetEnvCard(props) {
      const target = props.target || {};
      const configReady = props.configReady === true;
      const busy = props.busy === true;
      const providerSupported = target.state === 'supported';
      // 未实现卡片左槽位的灰色占位：工程未支持 vs 还没接入，措辞不混用。
      const stateText = target.state === 'unsupported' ? '未支持' : '未接入';
      // 总闸（目标环境）与分开关（运行环境）是两层：分开关只在总闸打开时才可操作，
      // 但关闭总闸不会改写各 provider 已保存的值。
      const masterEnabled = props.masterEnabled === true;
      const providerCurrent = props.providerCurrent === true;
      const switchDisabled = !providerSupported || !configReady || busy || !masterEnabled;
      const switchTitle = !providerSupported
        ? '当前运行环境未实现，不能启用'
        : !configReady
          ? (props.configError || '宿主配置不可用，无法提交启用状态')
          : busy ? '正在提交到宿主…'
            : !masterEnabled ? '目标环境总开关已关闭：已保存的开关值保留，重新打开后恢复'
              : '提交到宿主（按宿主版本号保存）';
      return h('div', {
        className: 'uts-item',
        'data-uts-target': target.id,
        'data-uts-provider': target.id,
        'data-uts-provider-state': providerSupported ? 'supported' : 'disabled',
        'data-uts-provider-current': providerCurrent ? 'true' : 'false',
        'data-uts-state': target.state,
        'data-uts-node': 'target',
      },
        h('div', { className: 'uts-card' },
          h('div', { className: 'uts-card-head' },
            h('span', { className: 'uts-card-title' },
              h('span', { className: 'uts-card-name' }, target.name)),
            // 开关挪到卡片右上角：卡片里不再有“用户启用：”这类说明文字；
            // 「当前使用 / 未选中」也不再单独标一枚标签——开关本身就反映了启用状态。
            // （provider 仍是 Host 解析出来的单选值，只是不再在卡片上重复写一遍。）
            h('span', { className: 'uts-card-switch', 'data-uts-switch-provider': target.id },
              h(TargetEnvSwitch, {
                label: '是否启用运行环境：' + target.name,
                checked: props.providerEnabled === true,
                disabled: switchDisabled,
                busy,
                title: switchTitle,
                onChange: (next) => {
                  if (typeof props.onToggleProvider === 'function') props.onToggleProvider(target.id, next);
                },
              }))),
          // 说明统一压到两行（超出省略，完整文字在 title 里）：卡片不再因为说明多一行就高低不齐。
          target.note ? h('div', { className: 'uts-card-note', title: target.note }, target.note) : null,
          // 卡片页脚：左边是状态槽（已实现一枚绿色「可用」；未实现一行灰字「未支持 / 未接入」），
          // 右边固定「诊断」按钮，永远贴右下角。原来的 已实现/未支持/未接入 标签样式（药丸）不再用，
          // 未实现只作灰字占位，避免它和「可用」抢同一层的视觉重量。
          h('div', { className: 'uts-card-foot' },
            providerSupported
              ? h('span', {
                className: 'uts-tag uts-available-tag',
                'data-uts-tag': 'supported',
                'data-uts-available': 'true',
              }, '可用')
              // 未实现也占住左槽位（灰色小字，非标签）：不然整行只剩右侧按钮，左轻右重。
              : h('span', {
                className: 'uts-card-state',
                'data-uts-card-state': target.state || 'planned',
              }, stateText),
            h('div', { className: 'uts-card-actions' },
              h('button', {
                type: 'button',
                className: 'uts-diagnose-btn',
                'data-uts-diagnose': target.id,
                title: '单独查看 ' + target.name + ' 的六轴诊断',
                onClick: (event) => {
                  if (typeof props.onDiagnose === 'function') props.onDiagnose(target.id, event && event.currentTarget);
                },
              }, '诊断')))));
    }

    /**
     * 一个环境分组：默认收齐（用户 2026-11-07 要求），点分组标题展开/收起该环境的候选卡片。
     * 六轴就绪条始终可见（不受折叠影响）；标题是 h4 里的 button（`aria-expanded`/`aria-controls`），
     * 卡片区域按需渲染为 region。
     */
    function TargetEnvGroup(props) {
      const group = props.group;
      const expanded = props.expanded === true;
      const axes = props.axes || [];
      const regionId = 'uts-group-' + group.id;
      return h('div', {
        className: 'uts-group',
        'data-uts-group': group.id,
        'data-uts-expanded': expanded ? 'true' : 'false',
      },
        h('h4', { className: 'uts-group-heading' },
          h('button', {
            type: 'button',
            className: 'uts-group-toggle',
            'aria-expanded': expanded,
            'aria-controls': regionId,
            'data-uts-group-toggle': group.id,
            onClick: () => props.onToggle(group.id),
          },
            h('span', { className: 'uts-group-title' }, group.title),
            h('span', { className: 'uts-group-count' }, group.targets.length + ' 个目标'),
            h('span', { className: 'uts-group-chevron', 'aria-hidden': true }, h(IconChevron, null))),
          // 目标环境总开关：与上面的展开/收起是两个不同控件（不同节点、不同属性），
          // 关闭它只停用整块执行，不抹掉各运行环境已保存的开关值。
          h('div', {
            className: 'uts-group-env',
            'data-uts-env-switch': group.id,
            'data-uts-env-enabled': props.envEnabled === true ? 'true' : 'false',
          },
            h(TargetEnvSwitch, {
              label: '目标环境总开关：' + group.title,
              checked: props.envEnabled === true,
              disabled: props.configReady !== true || props.busy === true,
              busy: props.busy === true,
              title: props.configReady !== true
                ? (props.configError || '宿主配置不可用，无法提交启用状态')
                : props.busy === true
                  ? '正在提交到宿主…'
                  : '关闭后停用整块执行；各运行环境已保存的开关值保留',
              onChange: (next) => {
                if (typeof props.onToggleEnv === 'function') props.onToggleEnv(next);
              },
            }))),
        expanded
          ? h('div', { className: 'uts-cards', id: regionId, role: 'region', 'aria-label': group.title },
              group.targets.length
                ? group.targets.map((target) => {
                    // 卡片只读 Host 配置（启用开关）与静态实现状态；六轴与 ③④ 在它自己的诊断页，
                    // 因此这里不再把 axes 传下去——同一事实只在一处渲染。
                    return h(TargetEnvCard, {
                      key: target.id,
                      target,
                      masterEnabled: props.envEnabled === true,
                      providerEnabled: props.providers ? props.providers[target.id] === true : false,
                      providerCurrent: props.currentProvider === target.id,
                      configReady: props.configReady,
                      configError: props.configError,
                      busy: props.busy,
                      onDiagnose: props.onDiagnose,
                      onToggleProvider: props.onToggleProvider,
                    });
                  })
                : h('p', { className: 'uts-empty' }, '暂未接入'))
          : null);
    }

    /**
     * 二级页：单个运行环境（provider）的诊断。
     *
     * 打开就**真实跑一次 Host 诊断**（`POST /plugins/ui-testing/diagnose`，NDJSON）：节点/边只用
     * Host 的五个 stage 结果说话（PASS/WARN/FAIL/SKIPPED/UNKNOWN），动画只由 stage-start /
     * stage-end 推动，六轴与事件流都来自本 run 的 run-end。没有 run 就没有绿色：这里不拿
     * readiness 快照冒充「已检查」。
     */
    function TargetEnvDiagnostics(props) {
      const group = props.group || { id: '', title: '', targets: [] };
      const target = props.target || {};
      const runKey = diagRunKey(group.id, target.id);
      const [run, setRun] = React.useState(() => DIAG_RUNS.get(runKey) || diagEmptyRun(target.id));
      // readiness 只用于「就绪快照」时间戳与（没有 run 时的）六轴兜底，run 期间不轮询。
      const hostConfig = useHostConfig(null, 'global', {
        pollMs: run.phase === 'running' ? 0 : DIAG_POLL_MS,
        initial: props.initialState,
        silent: true,
      });
      const state = hostConfig.state;
      const lastGoodRef = React.useRef(
        props.initialState && props.initialState.revision !== null && !props.initialState.error
          ? props.initialState
          : null,
      );
      if (!state.error && state.revision !== null) lastGoodRef.current = state;
      const stateError = String(state.error || '');
      const live = stateError ? (lastGoodRef.current || state) : state;
      const abortRef = React.useRef(null);
      const aliveRef = React.useRef(true);

      const applyRun = React.useCallback((next) => {
        if (!aliveRef.current) return;
        setRun(next);
        DIAG_RUNS.set(runKey, next);
      }, [runKey]);

      const startRun = React.useCallback((mode) => {
        try {
          startRunUnsafe(mode);
        } catch (error) {
          const message = '诊断 run 启动失败：' + String((error && error.message) || error);
          try { console.error('[ui-testing] ' + message, error); } catch { /* ignore */ }
          applyRun(Object.assign(diagEmptyRun(target.id), { phase: 'finished', error: message }));
        }
      }, [applyRun, target.id]);
      // The run keeps its own AbortController: the readiness polling controller must never abort it.
      const startRunUnsafe = React.useCallback((mode) => {
        if (abortRef.current) { try { abortRef.current.abort(); } catch { /* ignore */ } }
        const controller = typeof AbortController === 'function' ? new AbortController() : null;
        abortRef.current = controller;
        let current = Object.assign(diagEmptyRun(target.id), { phase: 'running', provider: target.id, mode });
        applyRun(current);
        startDiagnoseRun({
          provider: target.id,
          mode,
          signal: controller ? controller.signal : undefined,
          onEvent: (event) => {
            current = diagApplyEvent(current, event);
            applyRun(Object.assign({}, current));
          },
        }).then(() => {
          if (!aliveRef.current) return;
          if (current.phase !== 'finished') {
            current = Object.assign({}, current, { phase: 'finished' });
            applyRun(current);
          }
        }).catch((error) => {
          if (!aliveRef.current) return;
          if (error && error.name === 'AbortError') return;
          current = Object.assign({}, current, { phase: 'finished', error: hostConfigError(error) });
          applyRun(current);
        });
      }, [applyRun, target.id]);

      React.useEffect(() => {
        aliveRef.current = true;
        // 每次进入诊断页（= 每次点卡片「诊断」）都发起一次新的 observe run：用户点诊断就是要
        // 真实走一遍工具调用，缓存只用于「离开/失败时把上次结果回显出来」，绝不阻止新 run。
        // 旧动画不会被重放：动画只由本次 run 的 stage 事件打开。
        const stored = DIAG_RUNS.get(runKey);
        if (stored && stored.phase === 'finished' && stored.error) setRun(stored);
        startRun('observe');
        return () => {
          aliveRef.current = false;
          if (abortRef.current) { try { abortRef.current.abort(); } catch { /* ignore */ } }
        };
      }, [runKey, startRun]);

      const model = diagRunModel(run, target);
      const rows = diagRunRows(run);
      const overall = model.overall;
      // 本轮还没有结论时（没跑过 / 没跑出结果）统一说 `待诊断` / `诊断未完成`，不用五态里的词。
      const runless = diagRunlessText(run);
      const activeStage = DIAG_STAGE_IDS.find((stageId) => (run.stagePhase || {})[stageId] === 'running') || '';
      // 胶囊文案（可见）与标题共用同一份文本：胶囊窄的时候悬停仍能看到全句。
      const overallText = run.phase === 'running'
        ? '诊断进行中 · 第 ' + (activeStage || '?') + ' 阶段'
        : (runless || (diagStateLabel(overall.status) + (overall.reason ? ' · ' + diagReasonLabel(overall.reason) : '')));
      // ③ WARN browser-not-running 时才提供「启动浏览器后继续诊断」，用户点之前绝不启动。
      const coldBrowser = (run.stages || {})['3'] && run.stages['3'].status === 'WARN'
        && String(run.stages['3'].reason || '').includes('browser-not-running');
      // A run is in flight until its stream closes: the action is disabled meanwhile.
      const runBusy = run.phase === 'running';
      // "Already connected" = this run really reached the CDP stage (③ PASS).
      const hasConnection = Boolean((run.stages || {})['3'] && run.stages['3'].status === 'PASS');
      const runId = run.runId || '';
      const axesSource = run.axes
        ? DIAG_AXIS_ORDER.map((axisKey) => {
          const value = run.axes[axisKey];
          const status = typeof value === 'string' ? value : (value && value.status) || 'not-probed';
          // `run-end.axes.checks` is keyed by *check id* (`readonly-eval`, `target-list`), never by
          // axis: it is only evidence for the capability axis (which is what those checks measured).
          const rawChecks = run.axes.checks && typeof run.axes.checks === 'object' && !Array.isArray(run.axes.checks)
            ? run.axes.checks : null;
          return {
            axis: axisKey,
            status,
            reason: '来自本轮诊断',
            source: 'run',
            runId,
            checkedAt: run.finishedAt || null,
            checks: axisKey === 'capability' && rawChecks
              ? Object.fromEntries(Object.entries(rawChecks).map(([name, value]) => [name, { status: typeof value === 'string' ? value : String((value && value.status) || 'unknown') }]))
              : null,
            targetId: '',
          };
        })
        : providerAxes(live, group.id || '', target.id || '');
      // 没有真正读过 readiness 时不要编一个时间（06:00 那种 epoch 文案会被当成真实读数）。
      const updatedIso = live.lastReadAt ? diagIsoAt(live.lastReadAt) : '';
      const runTimeIso = diagIsoAt(run.finishedAt || run.startedAt || 0);

      return h('section', {
        className: 'uts-diagnostics-body',
        'data-uts-diagnostics': target.id || '',
        'data-uts-diagnostics-group': group.id || '',
        'data-uts-diagnostics-state': target.state || '',
        'data-uts-diag-poll': String(DIAG_POLL_MS),
        'data-uts-diag-stale': stateError ? 'true' : 'false',
        'data-uts-diag-updated': updatedIso,
        'data-uts-run-id': runId,
        'data-uts-run-phase': run.phase || 'idle',
        'data-uts-run-mode': run.mode || '',
        'data-uts-run-source': run.axes ? 'run' : 'readiness',
      },
        h('p', { className: 'uts-page-desc', 'data-uts-diag-scope': 'run' },
          '打开本页会真实执行一次诊断检查（不会启动浏览器），结果按五个阶段逐条返回；'
          + '需要浏览器时可用下方动作显式启动，离开本页会中止本次检查。'
          + '本页只反映当前作用域这一次诊断的结果，不代表其它会话中的调试目标不可用。'),
        h('div', { className: 'uts-diag-summary' },
          h('span', {
            className: 'uts-diag-overall',
            'data-uts-diag-overall': 'true',
            'data-uts-overall': overall.status,
            'data-uts-overall-reason': overall.reason || '',
            // 证据不删只收：本次 run / 就绪快照 / 副作用 / 实际调用 从可见文本挪到胶囊的悬停提示与
            // 机器可读属性上，界面保持干净但读得到同样的值。
            'data-uts-run-mode': run.mode || '',
            'data-uts-diag-updated-clock': updatedIso ? diagClock(updatedIso) : '',
            'data-uts-diag-side-effects': (run.sideEffects || []).map((effect) => effect.kind).join(','),
            'data-uts-diag-actual-calls': (run.actualCalls || []).map((call) => call.tool).join(','),
            title: [
              '状态：' + overallText,
              run.phase === 'running'
                ? '正在读取宿主事件流'
                : (run.mode ? '本轮：' + run.mode + (runTimeIso ? ' · ' + diagClock(runTimeIso) : '') : '尚无诊断记录'),
              updatedIso ? '就绪快照 ' + diagClock(updatedIso) : '',
              (run.sideEffects || []).length ? '副作用 ' + (run.sideEffects || []).map((effect) => effect.kind).join(' · ') : '',
              (run.actualCalls || []).length ? '实际调用 ' + (run.actualCalls || []).map((call) => call.tool).join(' · ') : '',
            ].filter(Boolean).join('；'),
            role: 'status',
          },
            h('i', { className: 'uts-diag-overall-dot', 'aria-hidden': true }),
            h('span', { 'data-uts-overall-text': 'true' }, overallText)),
          run.error
            ? h('p', { className: 'uts-diag-stale', 'data-uts-diag-error': 'true' }, run.error)
            : null,
          stateError
            ? h('p', { className: 'uts-diag-stale', 'data-uts-diag-error': 'true' },
              '就绪快照读取失败（不影响本轮结果）：' + stateError)
            : null,
          // 常驻动作：打开页面本身只做 observe（不启动浏览器），"开始诊断"才手动触发一轮 start。
          // 浏览器没在跑时由这一轮自己启动；已连接时只重新检查，不重启。run 进行中禁用，避免并发两轮。
          h('div', { className: 'uts-diag-action', 'data-uts-diag-action': 'start' },
            h('button', {
              type: 'button',
              className: 'uts-link-btn',
              'data-uts-diag-start': 'true',
              'data-uts-diag-run': 'start',
              'data-uts-action-disabled': runBusy ? 'true' : 'false',
              'data-uts-diag-action-note': runBusy ? 'busy' : coldBrowser || !hasConnection ? 'cold' : 'warm',
              // 说明文字不再占版面：搬到按钮的悬停提示里（三种分支同一套文案）。
              title: runBusy
                ? '本次诊断正在进行中，完成后再开始下一轮。'
                : (coldBrowser || !hasConnection
                  ? '会启动所选浏览器（' + (target.name || target.id) + '）并创建受管调试页；不会接管其它会话的标签。'
                  : '会重新执行五个阶段的检查，不会重启浏览器。'),
              disabled: runBusy,
              onClick: () => { if (!runBusy) startRun('start'); },
            }, '开始诊断'))),

        /* ① 实时调试拓扑：五节点 + 四条边（横排），全部取本次 run 的 stage 结果 */
        h('section', { className: 'uts-diag-panel', 'data-uts-diag-section': 'topology' },
          h('div', { className: 'uts-diag-panel-head' },
            h('h3', { className: 'uts-diag-panel-title' }, '调试流程')),
          h('div', { className: 'uts-diag-chain-scroll' },
            h('div', {
              className: 'uts-diag-chain',
              'data-uts-topology': 'true',
              'data-uts-topology-state': overall.status,
              'data-uts-run-phase': run.phase || 'idle',
            }, (() => {
              const cells = [h('div', {
                key: 'rail',
                className: 'uts-diag-rail',
                'data-uts-diag-rail': 'true',
                'aria-hidden': true,
              }, h('i', { className: 'uts-diag-rail-dot', 'data-uts-diag-rail-dot': 'true' }))];
              model.nodes.forEach((node, index) => {
                const stage = node.stage || null;
                const phase = (run.stagePhase || {})[String(node.index)] || 'idle';
                // 没有 run 结果时说「待诊断 / 诊断未完成」，有结果才用五态 + 原因码（中文在前、
                // 英文码在括号里，agent 仍可从 data-uts-stage-reason 读到原码）。
                const nodeStatusText = phase === 'running'
                  ? '检查中…'
                  : (runless || (diagStateLabel(node.state) + (stage && stage.reason ? ' · ' + diagReasonLabel(stage.reason) : '')));
                cells.push(h('div', {
                  key: 'node-' + node.index,
                  className: 'uts-diag-node',
                  'data-uts-node': String(node.index),
                  'data-uts-node-id': node.id,
                  'data-uts-node-state': node.state,
                  'data-uts-node-note': node.sub,
                  'data-uts-stage': String(node.index),
                  'data-uts-stage-status': node.state,
                  'data-uts-stage-phase': phase,
                  'data-uts-stage-reason': (stage && stage.reason) || '',
                  'data-uts-stage-blocked-by': stage && stage.blockedBy !== null && stage.blockedBy !== undefined ? String(stage.blockedBy) : '',
                  'data-uts-stage-duration': stage && stage.durationMs !== null && stage.durationMs !== undefined ? String(stage.durationMs) : '',
                  // 卡片里 name / 职责 / 状态都可能被截断：悬停给出完整四行，不留信息黑洞。
                  title: diagNodeTitle(node, nodeStatusText, stage, phase),
                },
                  h('div', { className: 'uts-diag-node-top' },
                    h('span', { className: 'uts-diag-node-index' }, '步骤 ' + node.index),
                    h('span', { className: 'uts-diag-node-glyph', 'aria-hidden': true }, diagNodeIcon(node.id))),
                  h('div', { className: 'uts-diag-node-role' }, node.role),
                  h('div', { className: 'uts-diag-node-name', 'data-uts-node-name': node.name, title: node.name }, node.name),
                  h('div', { className: 'uts-diag-node-sub', 'data-uts-node-sub': node.sub, title: node.sub }, node.sub),
                  h('div', { className: 'uts-diag-node-status' },
                    h('i', { className: 'uts-diag-dot', 'aria-hidden': true }),
                    h('span', { 'data-uts-node-status': node.state }, nodeStatusText))));
                const edge = model.edges[index];
                if (edge) {
                  cells.push(h('div', {
                    key: 'edge-' + edge.index,
                    className: 'uts-diag-edge',
                    'data-uts-edge': String(edge.index),
                    'data-uts-edge-state': edge.state,
                    'data-uts-edge-label': edge.label,
                    'data-uts-edge-live': edge.live ? 'true' : 'false',
                  },
                    h('span', { className: 'uts-diag-edge-line', 'aria-hidden': true },
                      h('i', { className: 'uts-diag-edge-dot', 'data-uts-edge-dot': 'true' })),
                    edge.state === 'FAIL'
                      ? h('span', { className: 'uts-diag-edge-break', 'aria-hidden': true }, '×')
                      : null,
                    h('span', { className: 'uts-diag-edge-label' }, edge.label)));
                }
              });
              return cells;
            })())),
          h('p', { className: 'uts-diag-flow' },
            '动画只跟随宿主事件回填：这一段开始检查时对应步骤脉冲，检查结束后该段静止；'
            + '只有本轮结论为「正常」的段才继续走球；结论是「异常」的，小球停在那个步骤上并写明原因。')),

        /* ② 六轴：来自 run-end.axes（原词表），没有 run 时才回退 readiness */
        h('section', { className: 'uts-diag-panel', 'data-uts-diag-section': 'axes' },
          h('div', { className: 'uts-diag-panel-head' },
            h('h3', { className: 'uts-diag-panel-title' }, '各模块诊断状态')),
          h('div', { className: 'uts-diag-axes', 'data-uts-axes': target.id || '' },
            axesSource.map((axis, order) => h('div', {
              key: axis.axis,
              className: 'uts-diag-axis',
              'data-uts-axis': axis.axis,
              'data-uts-status': axis.status,
              'data-uts-axis-order': String(order),
              'data-uts-axis-provider': target.id || '',
              'data-uts-axis-source': axis.source || 'readiness',
              'data-uts-axis-run-id': axis.runId || '',
              'data-uts-axis-target': axis.targetId || '',
              'data-uts-axis-checked-at': axis.checkedAt ? String(axis.checkedAt) : '',
              title: axisDetail(axis),
            },
              h('span', { className: 'uts-diag-axis-icon', 'aria-hidden': true }, diagAxisIcon(axis.axis)),
              h('div', { className: 'uts-diag-axis-body' },
                h('div', { className: 'uts-diag-axis-head' },
                  h('span', { className: 'uts-diag-axis-name' }, AXIS_LABEL[axis.axis] || axis.axis),
                  h('span', { className: 'uts-diag-axis-value' }, axisText(axis.axis, axis.status))),
                h('code', {
                  className: 'uts-diag-axis-reason',
                  'data-uts-axis-reason': axis.axis,
                  // 英文码单独留一个属性：界面上是「中文（code）」，agent 读这个属性拿纯码。
                  'data-uts-axis-reason-code': axis.reason || '',
                }, diagReasonLabel(axis.reason) || '无附加原因'),
                (() => {
                    // 六条探测逐行列出；完整列表（含英文 id）在悬停提示里。
                    // 没有检查项的卡片也渲染这块（空内容），保证六张卡片都按三行占位。
                    const rawChecks = axis.checks && typeof axis.checks === 'object' ? axis.checks : {};
                    const rows = Object.entries(rawChecks)
                      .map(([name, check]) => ({ name, status: String(check && check.status ? check.status : check) }));
                    // 界面上的检查项名与状态都写中文（只读求值：跳过），英文 id 留给属性与悬停提示。
                    const zh = rows.map((row) => diagTermLabel(row.name) + '：' + diagTermLabel(row.status));
                    // 一行一项、最多三行；还有几条用 `+n` 写在第三行末尾（完整列表见悬停提示）。
                    const shown = zh.slice(0, DIAG_CHECK_LINES);
                    const hidden = zh.length - shown.length;
                    const truncated = hidden > 0;
                    const pieces = shown.map((textValue, index) => {
                      const last = index === shown.length - 1;
                      if (!(truncated && last)) {
                        return h('span', { key: 'item-' + index, className: 'uts-diag-axis-checks-item' }, textValue);
                      }
                      // 「+n」单独一个 span：更小字号 + 更淡的颜色，读起来是计数标签，不是又一条描述。
                      return h('span', { key: 'item-' + index, className: 'uts-diag-axis-checks-item' },
                        textValue,
                        h('span', {
                          className: 'uts-diag-axis-checks-more',
                          'data-uts-axis-checks-more': String(hidden),
                        }, '+' + hidden));
                    });
                    return h('code', {
                      className: 'uts-diag-axis-checks',
                      'data-uts-axis-checks': axis.axis,
                      'data-uts-axis-checks-total': String(rows.length),
                      // agent 读纯英文对：readonly-eval: skip · target-list: skip · …
                      'data-uts-axis-checks-en': rows.map((row) => row.name + ': ' + row.status).join(' · '),
                      // 被省略的条数：界面上写成「+n」，外部断言可读这个值
                      'data-uts-axis-checks-truncated': truncated ? String(hidden) : '',
                      title: rows.map((row) => diagTermLabel(row.name) + '（' + row.name + '）：' + diagTermLabel(row.status)).join(' · '),
                    }, pieces);
                })()))))),

        /* ③ 诊断日志 + ④ 调试节点职责 */
        h('div', { className: 'uts-diag-bottom' },
          h('section', { className: 'uts-diag-panel', 'data-uts-diag-section': 'events' },
            h('div', { className: 'uts-diag-panel-head' },
              h('h3', { className: 'uts-diag-panel-title' }, '诊断日志')),
            h('div', {
              className: 'uts-diag-events',
              'data-uts-events': 'true',
              'data-uts-event-count': String((run.events || []).length),
            },
              rows.length
                ? rows.map((row) => {
                  // Host 的时间戳是 Date.now() 的数字，先统一转 ISO，否则 `diagClock` 解析失败 →
                  // 每行都显示 `--:--:--`。DOM 属性也写 ISO，方便外部核对。
                  const atIso = diagIsoAt(row.at);
                  const observedIso = diagIsoAt(run.finishedAt);
                  // run-start 不是检查结果，别拿「未知」冒充状态：文案「开始」+ INFO 中性灰点。
                  const statusKey = row.kind === 'run-start' ? 'INFO' : row.status;
                  const statusText = row.kind === 'run-start' ? '开始' : diagStateLabel(row.status);
                  return h('div', {
                    key: 'event-' + (row.seq || 0),
                    className: 'uts-diag-event',
                    'data-uts-event': 'true',
                    'data-uts-event-kind': row.kind,
                    'data-uts-event-axis': row.operation,
                    'data-uts-event-time': atIso,
                    'data-uts-event-time-source': 'host',
                    'data-uts-event-host-checked-at': atIso,
                    'data-uts-event-observed-at': observedIso,
                    'data-uts-event-from': '',
                    'data-uts-event-to': statusKey,
                    'data-uts-event-status': statusKey,
                    'data-uts-event-run-id': row.runId || '',
                    'data-uts-event-seq': String(row.seq || ''),
                    'data-uts-event-operation': row.operation,
                    'data-uts-event-evidence-ref': row.evidenceRef || '',
                    // 英文码单独留属性（agent 读纯码），可见文本走中英对照。
                    'data-uts-event-reason': row.reason || '',
                    title: diagOperationLabel(row.operation) + ' · ' + statusText + (row.reason ? ' · ' + diagReasonLabel(row.reason) : ''),
                  },
                    // SKIPPED 阶段从未执行，Host 就没有 finishedAt：显示「—」而不是假时间或占位符。
                    h('time', { className: 'uts-diag-event-time' }, atIso ? diagClock(atIso) : '—'),
                    h('i', { className: 'uts-diag-event-pin', 'data-uts-event-status': statusKey, 'aria-hidden': true }),
                    h('div', { className: 'uts-diag-event-text' },
                      diagOperationLabel(row.operation) + ' · ' + statusText
                      + (row.reason ? ' · ' + diagReasonLabel(row.reason) : '')
                      // 上游阻塞：写中文，英文键 blockedBy 只留在属性与 NDJSON 里。
                      + (row.blockedBy ? ' · 阻塞于第 ' + row.blockedBy + ' 段' : '')
                      + ' · ' + (row.durationMs === null || row.durationMs === undefined ? '—' : Math.round(row.durationMs * 10) / 10 + 'ms')));
                })
                : h('p', { className: 'uts-diag-empty', 'data-uts-events-empty': 'true' }, '尚未取得宿主诊断结果'))),
          h('section', { className: 'uts-diag-panel', 'data-uts-diag-section': 'duties' },
            h('div', { className: 'uts-diag-panel-head' },
              h('h3', { className: 'uts-diag-panel-title' }, '步骤职责')),
            h('div', { className: 'uts-diag-duties', 'data-uts-duties': 'true' },
              model.duties.map((duty) => h('div', {
                key: 'duty-' + duty.node,
                className: 'uts-diag-duty',
                'data-uts-duty': 'true',
                'data-uts-duty-node': duty.node,
              },
                h('span', { className: 'uts-diag-duty-arrow', 'aria-hidden': true }, '↗'),
                h('span', { className: 'uts-diag-duty-text' },
                  h('strong', null, duty.name),
                  ' ' + duty.text)))))));
    }

    /**
     * 诊断弹层（DSH 的 frame-wide `shell.overlay` 插槽）。
     *
     * 设置弹层太窄，横排五节点链路放不下；这里用一个独立的全宽覆盖层。插槽层本身是
     * click-through，所以条目自己开 `pointer-events`。关闭方式：✕ 按钮、Esc、点遮罩；
     * 关闭即中止进行中的 run（内容组件卸载时 abort）。
     */
    function DiagnosticsOverlay() {
      const overlay = useDiagnosticsOverlay();
      const open = overlay.open === true;
      const closeRef = React.useRef(null);
      React.useEffect(() => {
        if (!open) return undefined;
        const trigger = overlay.trigger;
        const previousOverflow = document.body.style.overflow;
        document.body.style.overflow = 'hidden';
        const onKeyDown = (event) => {
          if (event.key === 'Escape' || event.key === 'Esc') {
            event.stopPropagation();
            event.preventDefault();
            closeDiagnostics();
          }
        };
        document.addEventListener('keydown', onKeyDown, true);
        const focusTimer = setTimeout(() => {
          if (closeRef.current && typeof closeRef.current.focus === 'function') closeRef.current.focus();
        }, 0);
        return () => {
          document.removeEventListener('keydown', onKeyDown, true);
          document.body.style.overflow = previousOverflow;
          clearTimeout(focusTimer);
          if (trigger && trigger.isConnected && typeof trigger.focus === 'function') trigger.focus();
        };
      }, [open, overlay.trigger]);
      if (!open) return null;
      const group = TARGET_ENV_GROUPS.find((item) => item.id === overlay.groupId)
        || { id: overlay.groupId, title: overlay.groupId, targets: [] };
      const target = (group.targets || []).find((item) => item.id === overlay.providerId)
        || { id: overlay.providerId, name: overlay.providerId, state: 'planned' };
      const titleText = (target.name || target.id) + ' 诊断';
      const tag = target.state === 'supported' ? '已实现' : target.state === 'unsupported' ? '未支持' : '未接入';
      const tree = h('div', {
        className: 'uts-diag-modal-overlay',
        'data-uts-diag-modal-overlay': 'true',
        onClick: (event) => {
          if (event.target === event.currentTarget) closeDiagnostics();
        },
      },
        h('div', {
          className: 'uts-diag-modal-panel',
          'data-uts-diag-modal': target.id || '',
          role: 'dialog',
          'aria-modal': 'true',
          'aria-label': titleText,
          onClick: (event) => event.stopPropagation(),
        },
          h('header', { className: 'uts-diag-modal-head' },
            h('div', { className: 'uts-diag-modal-title' },
              h('h2', { className: 'uts-page-title' }, titleText),
              h('span', { className: 'uts-tag', 'data-uts-tag': target.state || 'planned' }, tag)),
            h('button', {
              type: 'button',
              className: 'uts-link-btn uts-diag-modal-close',
              'data-uts-diagnostics-back': 'true',
              ref: closeRef,
              onClick: () => closeDiagnostics(),
            }, '关闭')),
          h('div', { className: 'uts-diag-modal-body' },
            h(TargetEnvDiagnostics, { group, target }))));
      // `shell.overlay` items can end up inside a stacking context that sits below the settings
      // modal; portalling to <body> is the only placement that is reliably on top.
      if (reactDom && typeof reactDom.createPortal === 'function' && typeof document !== 'undefined') {
        return reactDom.createPortal(tree, document.body);
      }
      return tree;
    }

    /**
     * 设置页正文（DSH 设置弹层的独立分区）。标题/描述在这里渲染，因为 settings.section
     * 只提供导航标签，不提供页面标题；下面才是「目标环境配置」分组。
     * 配置真值来自 Host：读取失败显示 `[data-uts-config-error]`，启用开关按 revision 提交。
     */
    function TargetEnvSettingsPage() {
      const hostConfig = useHostConfig(null, 'global');
      const state = hostConfig.state;
      const [hideUnimplemented, setHideUnimplemented] = React.useState(false);
      const [expanded, setExpanded] = React.useState(readExpandedGroups);
      const [submittingEnv, setSubmittingEnv] = React.useState('');
      const [submittingProvider, setSubmittingProvider] = React.useState('');
      const [notice, setNotice] = React.useState(null);
      // 二级诊断页：记录 (环境, 运行环境)，为空时显示环境分组列表。
      const [diagnosing, setDiagnosing] = React.useState(null);
      const aliveRef = React.useRef(true);
      React.useEffect(() => () => { aliveRef.current = false; }, []);
      const configReady = state.revision !== null && !state.error;
      const groups = hideUnimplemented
        ? TARGET_ENV_GROUPS.map((group) => ({ ...group, targets: group.targets.filter((target) => target.state === 'supported') }))
          .filter((group) => group.targets.length > 0)
        : TARGET_ENV_GROUPS;
      function toggleGroup(id) {
        setExpanded((current) => {
          const next = Object.assign({}, current);
          if (next[id]) delete next[id];
          else next[id] = true;
          writeExpandedGroups(next);
          return next;
        });
      }
      function toggleEnvironment(group, next) {
        if (!configReady || submittingEnv) return;
        setSubmittingEnv(group.id);
        setNotice(null);
        putHostConfig({ environments: { [group.id]: { enabled: next } } }, state.revision).then((payload) => {
          if (!aliveRef.current) return;
          const merged = hostConfig.adopt(payload);
          if (payload.config === undefined) hostConfig.reload();
          publishHostConfigChange();
          setSubmittingEnv('');
          setNotice(merged.error
            ? { kind: 'error', text: configErrorText(merged.error) }
            : { kind: 'ok', text: (next ? '已启用 ' : '已禁用 ') + group.title + ' · revision ' + merged.revision });
        }).catch((error) => {
          if (!aliveRef.current) return;
          setSubmittingEnv('');
          if (error && error.code === 'CONFIG_CONFLICT') {
            adoptHostConflict(hostConfig, error);
            setNotice({
              kind: 'conflict',
              text: '配置已被其他窗口修改（CONFIG_CONFLICT）；已按最新 revision 重新读取，本次切换未保存',
            });
            return;
          }
          setNotice({
            kind: 'error',
            text: '保存失败，已回滚为宿主当前值：' + (configErrorText(error && error.message) || '未知错误'),
          });
        });
      }
      /**
       * 运行环境分开关：只写 `environments.<env>.providers.<id>.enabled`，与总开关互不影响。
       * 关闭总开关时不会调用这里，因此各 provider 的已保存值保持不变。
       */
      function toggleProvider(group, providerId, next) {
        if (!configReady || submittingEnv || submittingProvider) return;
        setSubmittingProvider(providerId);
        setNotice(null);
        const patch = { environments: { [group.id]: { providers: { [providerId]: { enabled: next } } } } };
        putHostConfig(patch, state.revision).then((payload) => {
          if (!aliveRef.current) return;
          const merged = hostConfig.adopt(payload);
          if (payload.config === undefined) hostConfig.reload();
          publishHostConfigChange();
          setSubmittingProvider('');
          const target = (group.targets || []).find((item) => item.id === providerId);
          const name = target && target.name ? target.name : providerId;
          setNotice(merged.error
            ? { kind: 'error', text: configErrorText(merged.error) }
            : { kind: 'ok', text: (next ? '已启用运行环境 ' : '已禁用运行环境 ') + name + ' · revision ' + merged.revision });
        }).catch((error) => {
          if (!aliveRef.current) return;
          setSubmittingProvider('');
          if (error && error.code === 'CONFIG_CONFLICT') {
            adoptHostConflict(hostConfig, error);
            setNotice({
              kind: 'conflict',
              text: '配置已被其他窗口修改（CONFIG_CONFLICT）；已按最新 revision 重新读取，本次切换未保存',
            });
            return;
          }
          setNotice({
            kind: 'error',
            text: '保存失败，已回滚为宿主当前值：' + (configErrorText(error && error.message) || '未知错误'),
          });
        });
      }
      const errorText = notice && notice.kind !== 'ok' ? notice.text : state.error;
      return h('section', {
        className: 'uts-settings',
        'data-uts-settings': 'page',
        'data-uts-hide-unimplemented': String(hideUnimplemented),
        'data-uts-config-revision': state.revision === null ? '' : String(state.revision),
        'data-uts-config-status': state.error ? 'error' : state.revision === null ? 'loading' : 'ready',
      },
        h('style', null, TARGET_ENV_CSS),
        h('header', { className: 'uts-head' },
          h('div', { className: 'uts-head-row' },
            h('h2', { className: 'uts-page-title' }, 'UI 测试'),
            // 不再提供「重新读取」按钮：面板一打开就会自动读一次 Host 配置
            // （useHostConfig 挂载即 GET /config?view=global），CONFIG_CONFLICT 时也会自动 adopt/reload。
            h('div', { className: 'uts-config-actions' },
              h('div', { className: 'uts-filter' },
                h('span', null, '隐藏未实现'),
                h(TargetEnvSwitch, { label: '隐藏未实现', checked: hideUnimplemented, onChange: setHideUnimplemented })))),
          h('p', { className: 'uts-page-desc' }, '面向 DeepSeekHarness 的前端 GUI 调试与测试插件：Web / Chromium 已实现；Windows/Linux/macOS 桌面、Android、TUI、HarmonyOS、小程序、游戏与 3D 共九种调试环境规划中。'),
          errorText
            ? h('p', {
                className: 'uts-config-error',
                role: 'alert',
                'data-uts-config-error': notice && notice.kind ? notice.kind : 'read',
              }, errorText)
            : null,
          notice && notice.kind === 'ok'
            ? h('p', { className: 'uts-config-meta', role: 'status', 'data-uts-config-notice': 'ok' }, notice.text)
            : null),
        h('div', { className: 'uts-body' },
          h('div', { className: 'uts-groups' }, groups.length
            ? groups.map((group) => {
                const axes = environmentAxes(state, group.id);
                const targetAxis = axes.find((axis) => axis.axis === 'target') || { status: 'not-probed', reason: '' };
                const readinessEntry = state.readiness ? state.readiness[group.id] : null;
                return h(TargetEnvGroup, {
                  key: group.id,
                  group,
                  axes,
                  checkedAt: readinessEntry ? readinessEntry.checkedAt : '',
                  expanded: expanded[group.id] === true,
                  onToggle: toggleGroup,
                  envEnabled: enabledFromConfig(state.config, group.id) === true,
                  providers: providersFromConfig(state.config, group.id),
                  currentProvider: currentProviderFromState(state),
                  configReady,
                  configError: state.loading ? '正在读取宿主配置…' : state.error,
                  busy: submittingEnv === group.id || submittingProvider !== '',
                  targetAxis,
                  onDiagnose: (providerId, trigger) => openDiagnostics(group.id, providerId, trigger),
                  onToggleEnv: (next) => toggleEnvironment(group, next),
                  onToggleProvider: (providerId, next) => toggleProvider(group, providerId, next),
                });
              })
            : h('p', { className: 'uts-empty' }, '暂无已实现的目标'))));
    }
    return {
      inject: ['slots'],
      apply(ctx) {
        // 面板组件在模块作用域定义，这里把根 ctx 交给它按需读取 DSH 服务（聊天框追加）。
        pluginContext = ctx;
        // 选元素引用的 `@` 来源：候选=最近选取的元素；chip 显示紧凑标签，模型文本走 codec.serialize。
        registerElementReferenceSource(ctx);
        // 发送后的用户消息里，同样的元素块折叠成紧凑 chip（模型文本不变）。
        registerUserTextElementReference(ctx);

        ctx.slots.inject('main', () => ctx.slots.register({ name: 'main', key: ID }, DebugView));

        // 用户 2026-11-06：在 DSH 设置弹层里注册独立设置页（设置 → UI 测试 → 目标环境配置）。
        // 只注册前端页面；本轮不探测环境、不写配置、不新增 Host 路由或工具。
        ctx.slots.inject('settings.section', () => ctx.slots.register({
          name: 'settings.section',
          id: 'ui-testing',
          order: 50,
          label: () => 'UI 测试',
        }, TargetEnvSettingsPage));

        // 诊断页放在 frame-wide 覆盖层（`shell.overlay`）里：设置弹层太窄，横排五节点链路放不下。
        // 该插槽层本身是 click-through，条目自己开 pointer-events（见 .uts-diag-modal-overlay）。
        ctx.slots.inject('shell.overlay', () => ctx.slots.register({
          name: 'shell.overlay',
          id: 'ui-testing.diagnostics',
          order: 50,
        }, DiagnosticsOverlay));

        // 左侧「更多」下拉里的一行：打开调试视图，不再占用左侧图标栏
        function MoreRow(props) {
          return typeof props.useSessions === 'function'
            ? h(MoreRowLive, props)
            : h(MoreRowContent, Object.assign({}, props, { capture: MAIN_CAPTURE_NONE }));
        }
        function MoreRowLive(props) {
          const capture = props.useSessions(mainViewCaptureSelector);
          return h(MoreRowContent, { onDismiss: props.onDismiss, capture });
        }
        function MoreRowContent(props) {
          const dismiss = props.onDismiss;
          return h(React.Fragment, null,
            h('style', null, CSS),
            h('button', {
              type: 'button',
              className: 'utb-menu-row',
              role: 'menuitem',
              onClick: () => {
                // Remember the workspace that owns the main view *before* opening the panel;
                // the root-scoped main panel reads this memory and pins itself to that Session.
                rememberMainCapture(props.capture);
                const layout = ctx.get('layout');
                if (!layout) { console.error('ui-testing: layout service unavailable'); return; }
                layout.selectPanel(ID);
                if (dismiss) dismiss();
              },
            }, h(IconBrowser, { size: 16 }), h('span', null, TITLE)));
        }
        ctx.slots.inject('sidebar.panellist.actions', () => ctx.slots.register({ name: 'sidebar.panellist.actions', id: ID, order: 20 }, MoreRow));

        // 右侧边栏：一个页签类型 + 引导页入口 + 页签正文
        ctx.slots.inject('sidebar.right.pane.tab', () => ctx.slots.register({ name: 'sidebar.right.pane.tab', key: ID }, DebugView));
        if (typeof ctx.inject === 'function') {
          ctx.inject(['sidebarRightTabs'], (sub) => {
            const tabs = sub.sidebarRightTabs || (sub.get && sub.get('sidebarRightTabs'));
            if (!tabs) return;
            const dispose = tabs.register({
              id: ID,
              kind: KIND,
              multiple: true,
              priority: 'builtin',
              title: () => TITLE,
              guide: [{ id: ID, order: 30, title: () => TITLE, description: () => '响应式预览网页并检查布局', icon: IconBrowser }],
            });
            if (typeof sub.effect === 'function') sub.effect(() => dispose, 'ui-testing: right sidebar tab type');
            else if (typeof ctx.effect === 'function') ctx.effect(() => dispose, 'ui-testing: right sidebar tab type');
          });
        }
      },
    };
  },
});
