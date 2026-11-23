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
