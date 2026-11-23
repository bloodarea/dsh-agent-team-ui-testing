    const ID = 'ui-testing-browser';
    /** 面板构建标识：刷新后用它确认浏览器里跑的是哪一份 client.js（排查「改了没生效」）。 */
    const CLIENT_BUILD = '2026-11-20·view-selection';
    const KIND = 'debug-view';
    const TITLE = '调试视图';
    // 目标环境清单**不在这里**：id 与显示名都来自 Host 的 `GET /config` 响应里的 `catalog`
    // （`core/config.js` 的 `environmentCatalog()`）。面板维护自己的静态表曾经导致两套对不上的词表
    // （面板宣告 `linux`，Host 注册的是 `linux-desktop`；面板还宣告了六个 Host 根本没登记的环境）。
    // 组件内按 catalog 派生 `ENVIRONMENTS`，见 `DebugViewBody` 开头。
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

    /**
     * POST /config/select —— 把面板选择（环境 id 或默认视图）提交为**本会话的视图选择**。
     *
     * 写的是 `view` 而不是 `environment`：`environment` 是旧字段，仍被读取但不再是新写入的入口。
     * Host 会把这个值同时记进会话与所属工作区（见 `docs/debug-panel.md`）。
     */
    function selectHostEnvironment(view, expectedRevision, scope) {
      return requestHostConfig('POST', '/config/select', { scope: 'session', view, expectedRevision }, { scope });
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
