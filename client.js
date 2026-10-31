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
    async function callHost(op, body) {
      const response = await fetch(HOST_BASE + '/' + op, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        credentials: 'same-origin',
        body: JSON.stringify(body || {}),
      });
      const payload = await response.json().catch(() => ({}));
      if (!response.ok || payload.ok === false) throw new Error(payload.error || ('运行时请求失败：' + response.status));
      return payload;
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
.utb-size { display: flex; align-items: center; gap: 8px; padding: 6px 8px; flex: 0 0 auto; font-size: 12px; color: var(--dsw-alias-label-secondary); background: var(--dsw-alias-bg-layer-1); border-bottom: 1px solid var(--dsw-alias-border-l1); }
.utb-num { width: 62px; height: 26px; padding: 0 6px; font: inherit; font-size: 12px; color: var(--dsw-alias-label-primary); background: var(--dsw-alias-bg-base); border: 1px solid var(--dsw-alias-border-l1); border-radius: 6px; }
.utb-size-left, .utb-size-right { display: flex; align-items: center; gap: 6px; flex: 0 0 auto; }
.utb-preset { height: 24px; padding: 0 10px; font: inherit; font-size: 12px; line-height: 22px; color: var(--dsw-alias-label-secondary); background: var(--dsw-alias-bg-base); border: 1px solid var(--dsw-alias-border-l1); border-radius: 7px; cursor: pointer; white-space: nowrap; }
.utb-preset:hover { color: var(--dsw-alias-label-primary); border-color: var(--dsw-alias-border-l2); }
.utb-preset[aria-pressed="true"] { color: var(--dsw-alias-brand-primary); border-color: var(--dsw-alias-brand-primary); background: color-mix(in srgb, var(--dsw-alias-brand-primary) 12%, transparent); }
.utb-preset:focus-visible { outline: 2px solid var(--dsw-alias-brand-primary); outline-offset: 1px; }
.utb-check { display: inline-flex; align-items: center; gap: 5px; cursor: pointer; }
.utb-dim { font-variant-numeric: tabular-nums; }
.utb-stage { position: relative; flex: 1 1 auto; min-height: 0; overflow: auto; display: flex; align-items: center; justify-content: center; background: var(--dsw-alias-bg-layer-2); }
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

    /** The debug view body, shared by the main column and the right sidebar. */
    function DebugView() {
      const [address, setAddress] = React.useState('');
      const [history, setHistory] = React.useState([]);
      const [index, setIndex] = React.useState(-1);
      const [revision, setRevision] = React.useState(0);
      const [sizing, setSizing] = React.useState(false);
      const [width, setWidth] = React.useState('393');
      const [height, setHeight] = React.useState('852');
      const [fit, setFit] = React.useState(true);
      const [room, setRoom] = React.useState({ w: 0, h: 0 });
      const [error, setError] = React.useState('');
      const [menu, setMenu] = React.useState(false);
      const [loading, setLoading] = React.useState(false);
      const [mode, setMode] = React.useState('idle');
      const [env, setEnv] = React.useState('web');
      const [shot, setShot] = React.useState('');
      const [remote, setRemote] = React.useState({ mode: 'idle', activity: '', url: '', running: false });
      const seqRef = React.useRef(0);
      const pollRef = React.useRef(0);
      const fpsCount = React.useRef({ frames: 0, since: performance.now(), lastFrameAt: 0 });
      const lastMove = React.useRef(0);
      const seededRef = React.useRef('');
      const [fps, setFps] = React.useState(0);
      const [frameMs, setFrameMs] = React.useState(0);
      const [activity, setActivity] = React.useState('无进行中的操作');
      const stage = React.useRef(null);
      const humanTimer = React.useRef(0);
      const url = history[index] || '';
      // 运行时里的地址优先：Agent 打开页面后用户也能在面板里看到
      const activeUrl = url || remote.url || '';
      let host = '';
      try { host = activeUrl ? new URL(activeUrl).host : ''; } catch (e) { host = ''; }

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

      // 帧流：轮询 Host 侧最新一帧，帧率与延迟都取自真实拉流
      React.useEffect(() => {
        let cancelled = false;
        let seeded = '';
        let seenFrame = false;
        async function tick() {
          if (cancelled) return;
          let state = null;
          try {
            const response = await fetch(HOST_BASE + '/frame?since=' + seqRef.current, { credentials: 'same-origin' });
            if (response.ok) {
              const payload = await response.json();
              state = payload.state || null;
              if (state) setRemote(state);
              if (!payload.pending && payload.image && payload.seq !== seqRef.current) {
                seqRef.current = payload.seq;
                setShot('data:image/jpeg;base64,' + payload.image);
                // 页面静止时最早那帧可能是几十秒前的：画面照用，但不计入帧率与延迟
                const age = payload.capturedAt ? Math.round(Date.now() - payload.capturedAt * 1000) : -1;
                if (age >= 0 && age < 3000) {
                  seenFrame = true;
                  setFrameMs(age);
                  const counter = fpsCount.current;
                  counter.frames += 1;
                  counter.lastFrameAt = performance.now();
                  const span = performance.now() - counter.since;
                  if (span >= 1000) {
                    setFps(Math.round((counter.frames * 1000) / span));
                    counter.frames = 0;
                    counter.since = performance.now();
                  }
                }
              } else if (fpsCount.current.lastFrameAt && performance.now() - fpsCount.current.lastFrameAt > 1200) {
                // 静止页面不发新帧：帧率归零，延迟保留上一次有效值
                setFps(0);
                fpsCount.current.frames = 0;
                fpsCount.current.since = performance.now();
              }
            }
          } catch { /* 运行时尚未启动 */ }
          // 静止页面不会发新帧：首帧用一次性截图补上，避免一直停在占位态
          if (!seenFrame && state && state.url && seeded !== state.url) {
            const seed = await callHost('screenshot').catch(() => null);
            if (seed && seed.image) {
              seeded = state.url;
              seenFrame = true;
              setShot('data:image/png;base64,' + seed.image);
              if (seed.capturedAt) {
                const endToEnd = Math.round(Date.now() - seed.capturedAt);
                if (endToEnd >= 0 && endToEnd < 3000) setFrameMs(endToEnd);
              }
            }
          }
          if (!cancelled) pollRef.current = window.setTimeout(tick, 80);
        }
        tick();
        return () => { cancelled = true; window.clearTimeout(pollRef.current); };
      }, []);

      // 视口同步：尺寸条改动后推给内嵌浏览器
      React.useEffect(() => {
        if (!sizing) return;
        const handle = window.setTimeout(() => {
          callHost('viewport', { width: pageSize.w, height: pageSize.h }).catch(() => {});
        }, 120);
        return () => window.clearTimeout(handle);
      }, [sizing, pageSize.w, pageSize.h]);

      function pagePoint(event) {
        const rect = event.currentTarget.getBoundingClientRect();
        if (!rect.width || !rect.height) return { x: 0, y: 0 };
        return {
          x: Math.round(((event.clientX - rect.left) / rect.width) * pageSize.w),
          y: Math.round(((event.clientY - rect.top) / rect.height) * pageSize.h),
        };
      }
      function sendEvents(events) {
        callHost('input', { events }).catch(() => {});
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

      function go(event) {
        if (event) event.preventDefault();
        try {
          const raw = address.trim();
          if (!raw) throw new Error('请输入网址。');
          const parsed = new URL(/^[a-z][a-z\d+.-]*:\/\//i.test(raw) ? raw : 'https://' + raw);
          if (parsed.protocol !== 'http:' && parsed.protocol !== 'https:') throw new Error('仅支持 HTTP 和 HTTPS 网址。');
          if (parsed.origin === window.location.origin || parsed.href.replace(/^[a-z][a-z\d+.-]*:\/\//i, '').split('/')[0].includes('@')) throw new Error('不支持应用自身地址或包含凭据的网址。');
          const next = history.slice(0, index + 1).concat(parsed.href);
          setHistory(next);
          setIndex(next.length - 1);
          setAddress(parsed.href);
          setError('');
          setLoading(true);
          setActivity('正在加载 ' + parsed.host);
          callHost('ensure', {})
            .then(() => callHost('viewport', { width: pageSize.w, height: pageSize.h }))
            .then(() => callHost('navigate', { url: parsed.href }))
            .then(() => { setLoading(false); })
            .catch((err) => { setLoading(false); setError((err && err.message) || '运行时不可用'); });
        } catch (err) {
          setError((err && err.message) || '请输入有效网址。');
        }
      }
      function move(next) {
        setIndex(next);
        setAddress(history[next]);
        setError('');
        setLoading(true);
        let target = '';
        try { target = new URL(history[next]).host; } catch (e) { target = ''; }
        setActivity(target ? '正在加载 ' + target : '无进行中的操作');
        if (history[next]) {
          setLoading(true);
          callHost('navigate', { url: history[next] })
            .then(() => setLoading(false))
            .catch((err) => { setLoading(false); setError((err && err.message) || '运行时不可用'); });
        }
      }
      function reload() {
        if (!url) return;
        setLoading(true);
        setActivity(host ? '正在重新加载 ' + host : '正在重新加载');
        callHost('navigate', { url })
          .then(() => setLoading(false))
          .catch((err) => { setLoading(false); setError((err && err.message) || '运行时不可用'); });
      }

      const w = Math.max(200, Math.min(4096, Number(width) || 200));
      const ht = Math.max(200, Math.min(4096, Number(height) || 200));
      const scale = sizing && fit && room.w > 24 && room.h > 24 ? Math.min(1, (room.w - 48) / w, (room.h - 24) / ht) : 1;
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
          button('后退', h(IconArrow, { dir: 'back' }), () => move(index - 1), index <= 0),
          button('前进', h(IconArrow, { dir: 'forward' }), () => move(index + 1), index < 0 || index >= history.length - 1),
          button('刷新', h(IconReload, null), reload, !url),
          h('form', { onSubmit: go, style: { flex: '1 1 auto', minWidth: 0, display: 'flex' } },
            h('input', { className: 'utb-addr', type: 'text', value: address, spellCheck: false, 'aria-label': '网址', placeholder: '输入网址，例如 https://example.com', 'aria-invalid': error ? 'true' : undefined, 'data-invalid': error ? 'true' : 'false', title: error || undefined, onChange: (e) => setAddress(e.target.value) })),
          button('尺寸调整', h(IconSize, null), () => setSizing((v) => !v), false, { 'aria-pressed': sizing }),
          h('span', { className: 'utb-sr', role: 'alert' }, error || ''),
          button('选择元素发送到聊天框（需浏览器运行时）', h(IconInspect, null), null, true),
          h('div', { className: 'utb-more' },
            button('更多', h(IconMore, null), () => setMenu((v) => !v), false, { 'aria-expanded': menu, 'aria-haspopup': 'menu' }),
            menu && h('div', { className: 'utb-pop', role: 'menu' },
              h('button', { type: 'button', className: 'utb-menu-item', role: 'menuitem', disabled: true, title: '需要浏览器运行时' }, '打开调试工具（暂不可用）'),
              url
                ? h('a', { className: 'utb-menu-item', role: 'menuitem', href: url, target: '_blank', rel: 'noopener noreferrer', style: { textDecoration: 'none' }, onClick: () => setMenu(false) }, '在默认浏览器中打开')
                : h('button', { type: 'button', className: 'utb-menu-item', role: 'menuitem', disabled: true }, '在默认浏览器中打开')))),
        sizing && h('div', { className: 'utb-size' },
          h('div', { className: 'utb-size-left', role: 'group', 'aria-label': '分辨率预设' },
            PRESETS.map((preset) => h('button', {
              key: preset.id,
              type: 'button',
              className: 'utb-preset',
              title: `${preset.label} ${preset.w} × ${preset.h}`,
              'aria-pressed': w === preset.w && ht === preset.h,
              onClick: () => { setWidth(String(preset.w)); setHeight(String(preset.h)); },
            }, preset.label))),
          h('span', { className: 'utb-gap' }),
          h('div', { className: 'utb-size-right' },
            h('input', { className: 'utb-num', type: 'number', min: 200, max: 4096, value: width, 'aria-label': '视口宽度（像素）', onChange: (e) => setWidth(e.target.value), onBlur: () => setWidth(String(w)) }),
            h('span', { 'aria-hidden': true }, '×'),
            h('input', { className: 'utb-num', type: 'number', min: 200, max: 4096, value: height, 'aria-label': '视口高度（像素）', onChange: (e) => setHeight(e.target.value), onBlur: () => setHeight(String(ht)) }),
            h('span', null, 'px'),
            h('label', { className: 'utb-check' }, h('input', { type: 'checkbox', checked: fit, onChange: (e) => setFit(e.target.checked) }), '适应窗口'),
            h('span', { className: 'utb-dim' }, `${Math.round(scale * 100)}%`))),
        h('div', { className: 'utb-stage', ref: stage },
          activeUrl
            ? (shot
              ? h('div', { className: 'utb-box', 'data-fitted': sizing && fit && scale < 1 ? 'true' : 'false', style: sizing ? { width: w * scale, height: ht * scale } : { width: '100%', height: '100%' } },
                h('img', {
                  className: 'utb-frame',
                  src: shot,
                  alt: '内嵌浏览器画面',
                  tabIndex: 0,
                  draggable: false,
                  style: { display: 'block', width: '100%', height: '100%', objectFit: 'contain', userSelect: 'none', touchAction: 'none' },
                  onPointerDown: (event) => {
                    event.preventDefault();
                    event.currentTarget.focus();
                    const point = pagePoint(event);
                    sendEvents([{ kind: 'mouse', type: 'mousePressed', x: point.x, y: point.y, button: 'left', buttons: 1, clickCount: 1 }]);
                    try { event.currentTarget.setPointerCapture(event.pointerId); } catch { /* ignore */ }
                  },
                  onPointerUp: (event) => {
                    const point = pagePoint(event);
                    sendEvents([{ kind: 'mouse', type: 'mouseReleased', x: point.x, y: point.y, button: 'left', buttons: 0, clickCount: 1 }]);
                    try { event.currentTarget.releasePointerCapture(event.pointerId); } catch { /* ignore */ }
                  },
                  onPointerMove: (event) => {
                    const now = Date.now();
                    if (now - lastMove.current < 60) return;
                    lastMove.current = now;
                    const point = pagePoint(event);
                    sendEvents([{ kind: 'mouse', type: 'mouseMoved', x: point.x, y: point.y, buttons: event.buttons ? 1 : 0 }]);
                  },
                  onWheel: (event) => {
                    event.preventDefault();
                    const point = pagePoint(event);
                    sendEvents([{ kind: 'wheel', x: point.x, y: point.y, deltaX: event.deltaX, deltaY: event.deltaY }]);
                  },
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
          h('span', { className: 'utb-perf', title: '拉流帧率与端到端延迟（帧采集 → 面板渲染）' }, `${fps} FPS ${frameMs} ms`),
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
          const dismiss = props && props.onDismiss;
          return h(React.Fragment, null,
            h('style', null, CSS),
            h('button', {
              type: 'button',
              className: 'utb-menu-row',
              role: 'menuitem',
              onClick: () => {
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
