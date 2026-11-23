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
