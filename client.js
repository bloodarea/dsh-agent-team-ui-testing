window.__ModuleLoader__.load({
  id: 'dsh-agent-team-ui-testing',
  factory(require) {
    const React = require('react');
    const h = React.createElement;

    const ID = 'ui-testing-browser';
    const KIND = 'debug-view';
    const TITLE = '调试视图';
    /** 可选运行环境；本期只有 Web 视图可用，其余置灰。 */
    const ENVIRONMENTS = [
      { id: 'web', label: 'Web 视图', ready: true },
      { id: 'windows', label: 'Windows 视图', ready: false },
      { id: 'android', label: 'Android 视图', ready: false },
      { id: 'linux', label: 'Linux 视图', ready: false },
      { id: 'macos', label: 'macOS 视图', ready: false },
      { id: 'tui', label: 'TUI 视图', ready: false },
      { id: 'harmonyos', label: 'HarmonyOS 视图', ready: false },
      { id: 'game', label: '游戏视图', ready: false },
      { id: 'three-d', label: '3D 视图', ready: false },
    ];
    /** 与 Host 半边的运行时通信（同源，走应用自身的鉴权）。 */
    const HOST_BASE = '/plugins/ui-testing';
    const SCOPE_VERSION = '1';

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

    function scopeHeaders(scope) {
      if (!scope) return {};
      const headers = { 'X-UI-Testing-Scope-Version': SCOPE_VERSION };
      if (scope.kind === 'session' && scope.sessionId) {
        headers['X-UI-Testing-Session-Id'] = scope.sessionId;
      } else if (scope.binding) {
        headers['X-UI-Testing-Scope-Binding'] = scope.binding;
      } else {
        headers['X-UI-Testing-Scope'] = 'recent';
      }
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

    /** 尺寸条左侧的分辨率预设。 */
    const PRESETS = [
      { id: 'wide', label: '宽屏', w: 1920, h: 1080 },
      { id: 'landscape', label: '横屏', w: 1024, h: 768 },
      { id: 'tablet', label: '平板', w: 768, h: 1024 },
      { id: 'phone', label: '手机', w: 393, h: 852 },
    ];
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
      scalePercent: [10, 200],
    };
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

    function clampNumber(value, min, max) {
      const number = Number(value);
      if (!Number.isFinite(number)) return min;
      return Math.max(min, Math.min(max, number));
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
     * Painted image rect for `object-fit: contain; object-position: 50% 50%` (contract §5.1).
     * `rect` is the img content box in *host* CSS px (border/padding already excluded by the
     * layout), natural* are the decoded frame pixels. The host window DPR never enters this
     * formula: event.clientX/Y, getBoundingClientRect and the target viewport are all CSS px.
     */
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
.utb-sr { position: absolute; width: 1px; height: 1px; margin: -1px; padding: 0; overflow: hidden; clip: rect(0 0 0 0); white-space: nowrap; border: 0; }
.utb-bar { display: flex; align-items: center; gap: 4px; padding: 6px 8px; flex: 0 0 auto; background: var(--dsw-alias-bg-layer-1); border-bottom: 1px solid var(--dsw-alias-border-l1); }
.utb-btn { display: inline-flex; align-items: center; justify-content: center; width: 28px; height: 28px; padding: 0; flex: 0 0 auto; color: var(--dsw-alias-label-secondary); background: transparent; border: 1px solid transparent; border-radius: 6px; cursor: pointer; }
.utb-btn:hover:not(:disabled) { color: var(--dsw-alias-label-primary); background: var(--dsw-alias-bg-layer-2); }
.utb-btn[aria-pressed="true"] { color: var(--dsw-alias-brand-primary); background: var(--dsw-alias-bg-layer-2); }
.utb-btn:disabled { opacity: .38; cursor: not-allowed; }
.utb-addr { flex: 1 1 auto; min-width: 0; height: 28px; padding: 0 10px; font: inherit; color: var(--dsw-alias-label-primary); background: var(--dsw-alias-bg-base); border: 1px solid var(--dsw-alias-border-l1); border-radius: 6px; }
.utb-addr::placeholder { color: var(--dsw-alias-label-secondary); }
.utb-addr[data-invalid="true"] { border-color: var(--dsw-alias-state-error-primary); outline-color: var(--dsw-alias-state-error-primary); }
.utb-addr:focus-visible, .utb-btn:focus-visible, .utb-menu-item:focus-visible, .utb-num:focus-visible { outline: 2px solid var(--dsw-alias-brand-primary); outline-offset: 1px; }
.utb-more { position: relative; flex: 0 0 auto; }
.utb-pop { position: absolute; right: 0; top: calc(100% + 4px); z-index: 20; min-width: 208px; padding: 4px; background: var(--dsw-alias-bg-overlay); border: 1px solid var(--dsw-alias-border-l1); border-radius: 8px; box-shadow: 0 8px 24px rgba(0,0,0,.28); }
.utb-menu-item { display: flex; align-items: center; gap: 8px; width: 100%; padding: 7px 10px; font: inherit; text-align: left; color: var(--dsw-alias-label-primary); background: transparent; border: 0; border-radius: 6px; cursor: pointer; }
.utb-menu-item:hover:not(:disabled) { background: var(--dsw-alias-bg-layer-2); }
.utb-menu-item:disabled { color: var(--dsw-alias-label-secondary); opacity: .6; cursor: not-allowed; }
.utb-size { display: flex; align-items: center; gap: 8px; padding: 6px 8px; flex: 0 0 auto; flex-wrap: wrap; row-gap: 4px; font-size: 12px; color: var(--dsw-alias-label-secondary); background: var(--dsw-alias-bg-layer-1); border-bottom: 1px solid var(--dsw-alias-border-l1); }
.utb-num { width: 62px; height: 26px; padding: 0 6px; font: inherit; font-size: 12px; color: var(--dsw-alias-label-primary); background: var(--dsw-alias-bg-base); border: 1px solid var(--dsw-alias-border-l1); border-radius: 6px; }
.utb-num:disabled { opacity: .55; cursor: not-allowed; }
.utb-size-left { display: flex; align-items: center; gap: 6px; flex: 0 0 auto; flex-wrap: wrap; row-gap: 4px; }
.utb-size-right { display: flex; align-items: center; gap: 6px; flex: 1 1 auto; flex-wrap: wrap; row-gap: 4px; justify-content: flex-end; min-width: 0; }
.utb-pos { width: 58px; }
.utb-pos-label { flex: 0 0 auto; font-variant-numeric: tabular-nums; }
.utb-preset { height: 24px; padding: 0 10px; font: inherit; font-size: 12px; line-height: 22px; color: var(--dsw-alias-label-secondary); background: var(--dsw-alias-bg-base); border: 1px solid var(--dsw-alias-border-l1); border-radius: 7px; cursor: pointer; white-space: nowrap; }
.utb-preset:hover { color: var(--dsw-alias-label-primary); border-color: var(--dsw-alias-border-l2); }
.utb-preset[aria-pressed="true"] { color: var(--dsw-alias-brand-primary); border-color: var(--dsw-alias-brand-primary); background: color-mix(in srgb, var(--dsw-alias-brand-primary) 12%, transparent); }
.utb-preset:focus-visible { outline: 2px solid var(--dsw-alias-brand-primary); outline-offset: 1px; }
.utb-check { display: inline-flex; align-items: center; gap: 5px; cursor: pointer; }
.utb-dim { font-variant-numeric: tabular-nums; }
.utb-num.utb-zoom { width: 54px; text-align: right; }
.utb-stage { position: relative; flex: 1 1 auto; min-height: 0; overflow: auto; display: flex; align-items: safe center; justify-content: safe center; background: var(--dsw-alias-bg-layer-2); }
.utb-box { flex: 0 0 auto; overflow: hidden; background: var(--dsw-alias-bg-base); }
.utb-box[data-fitted="true"] { box-shadow: 0 0 0 1px var(--dsw-alias-border-l2); }
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
    /** 选择元素：DevTools 的“检查元素”光标（虚线元素框 + 指针）。 */
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

    function frameSocketUrl(scope) {
      const scheme = location.protocol === 'https:' ? 'wss:' : 'ws:';
      let query = '?scopeVersion=' + SCOPE_VERSION;
      if (scope && scope.kind === 'session' && scope.sessionId) query += '&sessionId=' + encodeURIComponent(scope.sessionId);
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
      let seedFor = '';
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
        maybeSeed();
      }

      /** Static pages may not damage-paint after load: fill the first view with a PNG seed. */
      function maybeSeed() {
        if (closed) return;
        if (!lastState || !lastState.url) return;
        if (stats.received > 0) return;
        if (seedFor === lastState.url) return;
        if (Date.now() - urlSince < SEED_DELAY_MS) return;
        if (handlers.canWrite && !handlers.canWrite()) return;
        seedFor = lastState.url;
        callHost('screenshot', {}, { scope, signal }).then((payload) => {
          if (closed || !payload || !payload.image) return;
          stats.seeded += 1;
          const meta = {
            seed: true,
            seq: 0,
            epoch: lastEpoch < 0 ? 0 : lastEpoch,
            capturedAtMs: payload.capturedAt,
            width: payload.viewport && payload.viewport.width,
            height: payload.viewport && payload.viewport.height,
          };
          stats.lastMeta = meta;
          handlers.onFrame({ blob: blobFromBase64(payload.image, 'image/png'), meta });
        }).catch(() => {});
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
                  format: 'jpeg',
                }, blobFromBase64(payload.image, 'image/jpeg'));
              }
            }
          }
        } catch { /* runtime not started or transient network error */ }
        pollBusy = false;
        if (!closed && kind !== 'ws') {
          maybeSeed();
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
          socketTimer = 0;
          retryTimer = 0;
          stopPolling();
          if (socket) {
            try { socket.close(); } catch { /* ignore */ }
            socket = undefined;
          }
        },
        noteState,
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
      const [width, setWidth] = React.useState('393');
      const [height, setHeight] = React.useState('852');
      const [posX, setPosX] = React.useState('0');
      const [posY, setPosY] = React.useState('0');
      const [fit, setFit] = React.useState(true);
      const [zoom, setZoom] = React.useState('100');
      const [room, setRoom] = React.useState({ w: 0, h: 0 });
      const [error, setError] = React.useState('');
      const [menu, setMenu] = React.useState(false);
      const [pending, setPending] = React.useState(false);
      const [navBusy, setNavBusy] = React.useState(false);
      const [mode, setMode] = React.useState('idle');
      const [env, setEnv] = React.useState('web');
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
      // Displayed-frame geometry: the mapping and the post-resize input barrier both read it.
      const frameGeomRef = React.useRef(null);
      const pendingGeomRef = React.useRef(null);
      const dragRef = React.useRef({ active: false, pointerId: -1, x: 0, y: 0 });
      const hoverAtRef = React.useRef(0);
      const fitRef = React.useRef(true);
      const stageWheelRef = React.useRef(null);
      const sizeWheelRef = React.useRef(null);
      const frameImgRef = React.useRef(null);
      const sizeBarRef = React.useRef(null);

      // Immutable scope/binding for this generation. A `recent` identity is pinned to the Host
      // runtime id returned by the first /state (or /ensure); `binding` is empty until then.
      const seatSessionId = props && typeof props.seatSessionId === 'string' ? props.seatSessionId : '';
      const visible = !props || props.visible !== false;
      const capture = props && props.capture ? props.capture : { sessionId: '', resolution: 'none' };
      const identity = resolvePanelIdentity(seatSessionId, capture, props && props.liveCapture);
      const identityKey = identity.key;
      const [bindingState, setBindingState] = React.useState({ identityKey: '', value: '' });
      const [legacyState, setLegacyState] = React.useState({ identityKey: '', value: false });
      const binding = bindingState.identityKey === identityKey ? bindingState.value : '';
      const legacyHost = legacyState.identityKey === identityKey ? legacyState.value : false;
      const ready = identity.kind === 'session' || Boolean(binding) || legacyHost;
      const scope = React.useMemo(
        () => scopeSnapshot(identity.kind, identity.sessionId, binding, legacyHost),
        [identity.kind, identity.sessionId, binding, legacyHost],
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
      function noteHostScope(payload) {
        const current = scopeRef.current;
        if (!current || current.kind !== 'recent') return;
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
      const backDisabled = busy || !running || !ui || !uiHistory?.available || !uiHistory?.canGoBack;
      const forwardDisabled = busy || !running || !ui || !uiHistory?.available || !uiHistory?.canGoForward;
      const reloadDisabled = busy || !running || !trueAddress;
      const openUrl = (() => {
        if (!trueAddress) return '';
        try {
          const parsed = new URL(trueAddress);
          return parsed.protocol === 'http:' || parsed.protocol === 'https:' ? parsed.href : '';
        } catch { return ''; }
      })();

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
          if (previousUi && String(previousUi.runtimeId) === runtimeId && Number(nextUi.revision) <= Number(previousUi.revision)) return false;
          if (previousUi && String(previousUi.runtimeId) !== runtimeId) {
            // A new runtime: drop the old address source and ignore its late replies.
            retiredRuntimeRef.current = String(previousUi.runtimeId || '');
            dirtyRef.current = false;
            editVersionRef.current += 1;
            setError('');
          }
        }
        remoteRef.current = next;
        setRemote(next);
        if (!pendingRef.current.active && !dirtyRef.current) {
          setDraft(nextUi ? String(nextUi.address || '') : String(next.url || ''));
        }
        // The shared view (when the Host has one) is adopted through the same accepted snapshot.
        acceptView(next);
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
        if (dirty.width === null) setWidth(String(Number(view.width) || 200));
        if (dirty.height === null) setHeight(String(Number(view.height) || 200));
        if (dirty.x === null) setPosX(formatScroll(scroll.x));
        if (dirty.y === null) setPosY(formatScroll(scroll.y));
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
        viewRef.current = view;
        if (viewMeta !== undefined) viewMetaRef.current = viewMeta || null;
        if (observed !== undefined) observedRef.current = observed || null;
        const source = String(view.source || '');
        // Only a *content change* by someone else cancels the local fit; an unchanged poll must not
        // (otherwise a user could never keep 适应窗口 checked while state is polled every 500ms).
        const revisionChanged = !previous || Number(previous.revision) !== Number(view.revision);
        const external = source === 'agent'
          || (source === 'gui' && Number(view.revision) !== Number(selfViewRevisionRef.current));
        if (external && revisionChanged) {
          fitRef.current = false;
          setFit(false);
        }
        if (previous && (Number(previous.width) !== Number(view.width) || Number(previous.height) !== Number(view.height))) {
          pendingGeomRef.current = { since: Date.now() };
        }
        clearCaughtUpDrafts(view);
        syncViewDrafts();
      }

      /** Ingest the view part of one accepted Host snapshot (first binding included). */
      function acceptView(payload) {
        const state = payload && payload.state && typeof payload.state === 'object' ? payload.state : payload;
        const ui = state && state.ui && typeof state.ui === 'object' ? state.ui : null;
        // A snapshot without the GUI projection says nothing about the shared view: leave the
        // last accepted view (and the legacy fallback) untouched.
        if (!ui) return;
        const view = viewOf(state);
        if (!view) {
          // Old Host (no shared view): keep the legacy local width/height path untouched.
          viewRef.current = null;
          observedRef.current = null;
          return;
        }
        maybeInitialViewPush(view);
        const companions = viewCompanionsOf(state);
        adoptView(view, companions.viewMeta, companions.observed);
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
        const dirty = viewDirtyRef.current;
        dirty.width = 393;
        dirty.height = 852;
        dirty.scale = 100;
        setWidth('393');
        setHeight('852');
        queueViewPatch({ width: 393, height: 852, scale: 1 });
      }

      /** Merge one field patch into the 120ms trailing debounce (at most one request in flight). */
      function queueViewPatch(patch) {
        if (!patch || typeof patch !== 'object') return;
        viewQueueRef.current = Object.assign({}, viewQueueRef.current || {}, patch);
        if (viewTimerRef.current) window.clearTimeout(viewTimerRef.current);
        viewTimerRef.current = window.setTimeout(() => { flushViewPatch(); }, VIEW_DEBOUNCE_MS);
      }

      /**
       * Send the merged patch. A new Host gets the v1 body (`version`/`expectedRevision`, per-field
       * patch); an old Host keeps the legacy `{width,height}` body and its old semantics.
       */
      async function flushViewPatch() {
        viewTimerRef.current = 0;
        const patch = viewQueueRef.current;
        viewQueueRef.current = null;
        if (!patch) return;
        if (viewInFlightRef.current) {
          viewQueuedRef.current = Object.assign({}, viewQueuedRef.current || {}, patch);
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
          Object.assign(body, patch);
        } else {
          body.width = Number.isFinite(Number(patch.width)) ? Number(patch.width) : pageSize.w;
          body.height = Number.isFinite(Number(patch.height)) ? Number(patch.height) : pageSize.h;
        }
        const submitted = {};
        for (const field of Object.keys(patch)) submitted[field] = viewEditRef.current[field];
        viewInFlightRef.current = true;
        try {
          const payload = await callHost('viewport', body, { scope: scopeNow, signal });
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
        } catch (error) {
          if (error && error.name === 'AbortError') return;
          const code = error && error.code ? String(error.code) : '';
          // A revision conflict keeps a *typed* draft (the user must resubmit it explicitly) but a
          // rejected wheel notch is not a draft: showing a value the Host never accepted would lie
          // about the shared view, so that field snaps back to the accepted truth.
          const details = error && error.payload && error.payload.details ? error.payload.details : null;
          const conflictView = (details && details.view) || null;
          if (conflictView) {
            selfViewRevisionRef.current = Number(conflictView.revision);
            adoptView(conflictView, undefined, undefined);
          }
          clearSettledWheelDrafts(submitted);
          if (code) logViewReject(code);
          syncViewDrafts();
        } finally {
          viewInFlightRef.current = false;
          if (viewQueuedRef.current) {
            viewQueueRef.current = Object.assign({}, viewQueueRef.current || {}, viewQueuedRef.current);
            viewQueuedRef.current = null;
            flushViewPatch();
          }
        }
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
        const scroll = observedScroll();
        if (field === 'x') return scroll.x;
        if (field === 'y') return scroll.y;
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
          const range = VIEW_LIMITS.scroll;
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
              : VIEW_LIMITS.scroll;
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

      /** Current painted rect of the displayed frame (contract §5.1); null disables input. */
      function frameGeometry() {
        const img = frameImgRef.current;
        if (!img) return null;
        return paintedRect(img.getBoundingClientRect(), img.naturalWidth, img.naturalHeight);
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
      function mapEventPoint(event, geom) {
        const size = acceptedViewSize();
        const u = (event.clientX - geom.left) / geom.width;
        const v = (event.clientY - geom.top) / geom.height;
        return {
          inside: u >= 0 && u < 1 && v >= 0 && v < 1,
          x: clampNumber(u * size.w, 0, Math.max(0, size.w - POINTER_EPSILON)),
          y: clampNumber(v * size.h, 0, Math.max(0, size.h - POINTER_EPSILON)),
        };
      }

      function frameInputReady() {
        return readyRef.current && !writesPausedRef.current && inputGeomReady();
      }

      function onFramePointerDown(event) {
        if (!frameInputReady()) return;
        if (event.button !== 0) return;
        const geom = frameGeometry();
        if (!geom) return;
        const point = mapEventPoint(event, geom);
        if (!point.inside) return; // letterbox: zero dispatch
        event.preventDefault();
        event.currentTarget.focus();
        dragRef.current = { active: true, pointerId: event.pointerId, x: point.x, y: point.y };
        try { event.currentTarget.setPointerCapture(event.pointerId); } catch { /* ignore */ }
        sendEvents([{ kind: 'mouse', type: 'mousePressed', x: point.x, y: point.y, button: 'left', buttons: 1, clickCount: 1 }]);
      }

      function onFramePointerMove(event) {
        if (!readyRef.current || writesPausedRef.current) return;
        const drag = dragRef.current;
        const dragging = drag.active && drag.pointerId === event.pointerId;
        if (!dragging && !inputGeomReady()) return;
        const geom = frameGeometry();
        if (!geom) return;
        const point = mapEventPoint(event, geom);
        if (!dragging && !point.inside) return;
        const now = Date.now();
        if (now - hoverAtRef.current < 60) return;
        hoverAtRef.current = now;
        if (dragging) dragRef.current = { active: true, pointerId: event.pointerId, x: point.x, y: point.y };
        sendEvents([{ kind: 'mouse', type: 'mouseMoved', x: point.x, y: point.y, buttons: dragging ? 1 : 0 }]);
      }

      /** The release is dispatched even when the pointer left the image (no stuck button). */
      function onFramePointerUp(event) {
        const drag = dragRef.current;
        if (!drag.active || drag.pointerId !== event.pointerId) return;
        dragRef.current = { active: false, pointerId: -1, x: drag.x, y: drag.y };
        const geom = frameGeometry();
        const point = geom ? mapEventPoint(event, geom) : null;
        if (point) sendEvents([{ kind: 'mouse', type: 'mouseReleased', x: point.x, y: point.y, button: 'left', buttons: 0, clickCount: 1 }]);
        try { event.currentTarget.releasePointerCapture(event.pointerId); } catch { /* ignore */ }
      }

      /** Best-effort release for pointercancel / lost capture / blur while dragging. */
      function releaseFrameDrag() {
        const drag = dragRef.current;
        if (!drag.active) return;
        dragRef.current = { active: false, pointerId: -1, x: drag.x, y: drag.y };
        sendEvents([{ kind: 'mouse', type: 'mouseReleased', x: drag.x, y: drag.y, button: 'left', buttons: 0, clickCount: 1 }]);
      }

      function onFrameWheel(event) {
        if (!frameInputReady()) return;
        const geom = frameGeometry();
        if (!geom) return;
        const point = mapEventPoint(event, geom);
        if (!point.inside) return; // only inside the painted frame prevents host scrolling
        event.preventDefault();
        event.stopPropagation();
        markHuman();
        const size = acceptedViewSize();
        sendEvents([{
          kind: 'wheel',
          x: point.x,
          y: point.y,
          deltaX: frameWheelDelta(event.deltaX, event.deltaMode, geom.width, size.w),
          deltaY: frameWheelDelta(event.deltaY, event.deltaMode, geom.height, size.h),
        }]);
      }

      function onStageWheel(event) {
        const target = event.target;
        if (!target || !target.closest || !target.closest('.utb-frame')) return;
        if (event.ctrlKey || event.metaKey) return; // host/browser zoom stays with the shell
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
        viewInFlightRef.current = false;
        viewRef.current = null;
        viewMetaRef.current = null;
        observedRef.current = null;
        viewDirtyRef.current = { x: null, y: null, width: null, height: null, scale: null };
        viewFocusRef.current = '';
        viewFirstBindRef.current = { epoch: scopeEpoch, done: false };
        selfViewRevisionRef.current = 0;
        frameGeomRef.current = null;
        pendingGeomRef.current = null;
        dragRef.current = { active: false, pointerId: -1, x: 0, y: 0 };
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
              ingestHostState(state);
              if (transportRef.current) transportRef.current.noteState({ url: state.url });
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
        const meta = frameMetaRef.current.get(source);
        // The mapping and the post-resize barrier both read the *displayed* frame: decoded
        // natural* plus the capture-time CSS page size (never the screencast metadata width).
        frameGeomRef.current = {
          naturalW: Number(image.naturalWidth) || 0,
          naturalH: Number(image.naturalHeight) || 0,
          pageWidth: meta ? Number(meta.pageWidth) : NaN,
          pageHeight: meta ? Number(meta.pageHeight) : NaN,
          at: Date.now(),
        };
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

      function sendEvents(events) {
        if (!readyRef.current || writesPausedRef.current) return;
        const signal = abortRef.current ? abortRef.current.signal : undefined;
        callHost('input', { events }, { scope: scopeRef.current, signal }).catch(() => {});
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

      function submit(event) {
        if (event) event.preventDefault();
        if (pendingRef.current.active) return;
        if (writesPausedRef.current) {
          console.warn('ui-testing: navigation paused while the main view is loading or ambiguous');
          return;
        }
        let parsed;
        try {
          const raw = draft.trim();
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
        if (reloadDisabled || writesPausedRef.current || !readyRef.current) return;
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
        const disabled = direction === 'back' ? backDisabled : forwardDisabled;
        if (disabled || writesPausedRef.current || !readyRef.current) return;
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
      /** 手动改比例时关闭自动适配并同步共享比例；重新勾选“适应窗口”只恢复本地自动适配。 */
      function changeFit(checked) {
        fitRef.current = checked;
        setFit(checked);
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
      function changeZoom(value) {
        changeScaleField(value);
      }
      function commitZoom() {
        commitViewField('scale');
      }
      stageWheelRef.current = onStageWheel;
      sizeWheelRef.current = onSizeWheel;
      const button = (label, children, onClick, disabled, extra) =>
        h('button', Object.assign({ type: 'button', className: 'utb-btn', title: label, 'aria-label': label, onClick, disabled }, extra || {}), children);

      return h('div', {
        className: 'utb',
        onPointerDown: markHuman,
        onKeyDown: markHuman,
        onWheel: markHuman,
      },
        h('style', null, CSS),
        h('div', { className: 'utb-top' },
          h('span', { className: 'utb-env-icon', 'aria-hidden': true }, h(IconWindow, null)),
          h('div', { className: 'utb-env-text' },
            h('span', { className: 'utb-env-title' }, 'Web · 调试视图')),
          h('span', { className: 'utb-gap' }),
          h('label', { className: 'utb-env-pick' },
            h('span', { className: 'utb-sr' }, '选择运行环境'),
            h('select', {
              className: 'utb-select',
              value: env,
              'aria-label': '选择运行环境',
              onChange: (e) => setEnv(e.target.value),
            }, ENVIRONMENTS.map((option) => h('option', { key: option.id, value: option.id, disabled: !option.ready }, option.label))),
            h('span', { className: 'utb-env-caret', 'aria-hidden': true }, h(IconChevron, null)))),
        h('div', { className: 'utb-bar' },
          button('后退', h(IconArrow, { dir: 'back' }), () => move('back'), backDisabled),
          button('前进', h(IconArrow, { dir: 'forward' }), () => move('forward'), forwardDisabled),
          button('刷新', h(IconReload, null), reload, reloadDisabled),
          h('form', { onSubmit: submit, style: { flex: '1 1 auto', minWidth: 0, display: 'flex' } },
            h('input', { className: 'utb-addr', type: 'text', value: draft, spellCheck: false, 'aria-label': '网址', placeholder: '输入网址，例如 https://example.com', 'aria-invalid': error ? 'true' : undefined, 'data-invalid': error ? 'true' : 'false', title: error || undefined, onChange: changeAddress, onFocus: () => { focusedRef.current = true; dirtyRef.current = false; }, onBlur: blurAddress, onKeyDown: keyAddress })),
          button('尺寸调整', h(IconSize, null), () => setSizing((v) => !v), false, { 'aria-pressed': sizing }),
          h('span', { className: 'utb-sr', role: 'alert' }, error || ''),
          button('选择元素发送到聊天框（需浏览器运行时）', h(IconInspect, null), null, true),
          h('div', { className: 'utb-more' },
            button('更多', h(IconMore, null), () => setMenu((v) => !v), false, { 'aria-expanded': menu, 'aria-haspopup': 'menu' }),
            menu && h('div', { className: 'utb-pop', role: 'menu' },
              h('button', { type: 'button', className: 'utb-menu-item', role: 'menuitem', disabled: true, title: '需要浏览器运行时' }, '打开调试工具（暂不可用）'),
              openUrl
                ? h('a', { className: 'utb-menu-item', role: 'menuitem', href: openUrl, target: '_blank', rel: 'noopener noreferrer', style: { textDecoration: 'none' }, onClick: () => setMenu(false) }, '在默认浏览器中打开')
                : h('button', { type: 'button', className: 'utb-menu-item', role: 'menuitem', disabled: true }, '在默认浏览器中打开')))),
        sizing && h('div', { className: 'utb-size', ref: sizeBarRef },
          h('div', { className: 'utb-size-left', role: 'group', 'aria-label': '分辨率预设' },
            PRESETS.map((preset) => h('button', {
              key: preset.id,
              type: 'button',
              className: 'utb-preset',
              title: `${preset.label} ${preset.w} × ${preset.h}`,
              'aria-pressed': w === preset.w && ht === preset.h,
              onClick: () => {
                changeSizeField('width', String(preset.w));
                changeSizeField('height', String(preset.h));
              },
            }, preset.label))),
          h('span', { className: 'utb-gap' }),
          h('div', { className: 'utb-size-right' },
            h('span', { className: 'utb-pos-label', 'aria-hidden': true }, 'X'),
            h('input', {
              className: 'utb-num utb-pos',
              type: 'number',
              min: VIEW_LIMITS.scroll[0],
              max: VIEW_LIMITS.scroll[1],
              step: 10,
              value: posX,
              'data-utb-field': 'x',
              'aria-label': '视口 X 坐标（像素）',
              title: viewSync
                ? '页面顶层滚动位置 X（文档 CSS px）；滚轮调整（Shift ×10，Alt ×1），Enter 提交，Esc 恢复'
                : '旧 Host 不支持视口坐标同步',
              disabled: !viewSync,
              onChange: (e) => changePositionField('x', e.target.value),
              onFocus: () => { viewFocusRef.current = 'x'; },
              onBlur: () => { viewFocusRef.current = ''; commitViewField('x'); },
              onKeyDown: (e) => sizeFieldKey(e, 'x'),
            }),
            h('span', { className: 'utb-pos-label', 'aria-hidden': true }, 'Y'),
            h('input', {
              className: 'utb-num utb-pos',
              type: 'number',
              min: VIEW_LIMITS.scroll[0],
              max: VIEW_LIMITS.scroll[1],
              step: 10,
              value: posY,
              'data-utb-field': 'y',
              'aria-label': '视口 Y 坐标（像素）',
              title: viewSync
                ? '页面顶层滚动位置 Y（文档 CSS px）；滚轮调整（Shift ×10，Alt ×1），Enter 提交，Esc 恢复'
                : '旧 Host 不支持视口坐标同步',
              disabled: !viewSync,
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
              onChange: (e) => changeSizeField('height', e.target.value),
              onFocus: () => { viewFocusRef.current = 'height'; },
              onBlur: () => { viewFocusRef.current = ''; commitViewField('height'); },
              onKeyDown: (e) => sizeFieldKey(e, 'height'),
            }),
            h('span', null, 'px'),
            h('label', { className: 'utb-check', title: '适应窗口仅本地显示，不改变共享比例/Agent 截图比例' },
              h('input', { type: 'checkbox', checked: fit, onChange: (e) => changeFit(e.target.checked) }),
              '适应窗口'),
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
              onChange: (e) => changeZoom(e.target.value),
              onFocus: () => { viewFocusRef.current = 'scale'; },
              onBlur: () => { viewFocusRef.current = ''; commitZoom(); },
              onKeyDown: (e) => sizeFieldKey(e, 'scale'),
            }),
            h('span', { className: 'utb-dim', 'aria-hidden': true }, '%'))),
        h('div', { className: 'utb-stage', ref: stage },
          activeUrl
            ? (shot
              ? h('div', { className: 'utb-box', 'data-fitted': fit && scale < 1 ? 'true' : 'false', style: { width: w * scale, height: ht * scale } },
                h('img', {
                  className: 'utb-frame',
                  ref: frameImgRef,
                  src: shot,
                  alt: '内嵌浏览器画面',
                  onLoad: onFrameLoad,
                  tabIndex: 0,
                  draggable: false,
                  style: { display: 'block', width: '100%', height: '100%', objectFit: 'contain', objectPosition: '50% 50%', userSelect: 'none', touchAction: 'none' },
                  onPointerDown: onFramePointerDown,
                  onPointerUp: onFramePointerUp,
                  onPointerMove: onFramePointerMove,
                  onPointerCancel: releaseFrameDrag,
                  onLostPointerCapture: releaseFrameDrag,
                  onKeyDown: (event) => {
                    if (event.metaKey || event.ctrlKey || event.altKey) return;
                    event.preventDefault();
                    if (event.key.length === 1) {
                      sendEvents([{ kind: 'text', text: event.key }]);
                      return;
                    }
                    const virtual = { Backspace: 8, Tab: 9, Enter: 13, Escape: 27, ArrowLeft: 37, ArrowUp: 38, ArrowRight: 39, ArrowDown: 40, Delete: 46 }[event.key];
                    if (!virtual) return;
                    sendEvents([
                      { kind: 'key', type: 'keyDown', key: event.key, code: event.code, virtualKeyCode: virtual },
                      { kind: 'key', type: 'keyUp', key: event.key, code: event.code, virtualKeyCode: virtual },
                    ]);
                  },
                }))
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
          h('span', { className: 'utb-gap' }),
          h('span', { className: 'utb-activity', title: remote.activity ? `运行时：${remote.activity}` : '视图状态' },
            remote.activity || activity)));
    }

    return {
      inject: ['slots'],
      apply(ctx) {

        ctx.slots.inject('main', () => ctx.slots.register({ name: 'main', key: ID }, DebugView));

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
