      /**
       * 可选目标环境：**id、显示名、实现状态全部来自 Host catalog**，面板不再有本地静态表。
       *
       * - `ready` 由 Host 的 `status` 决定（`supported` 才允许提交 `config/select`）；planned 环境
       *   仍可选择本地视图，走空白画布分支。
       * - `testOnly` 行不进普通用户的下拉框（夹具环境由测试面自己渲染）。
       * - catalog 还没读到时只保留 web，不凭本地表猜有哪些环境（读到后再展开）。
       */
      const ENVIRONMENTS = React.useMemo(() => {
        const catalog = Array.isArray(hostConfig.state.catalog) ? hostConfig.state.catalog : [];
        const rows = catalog
          .filter((item) => item && typeof item.id === 'string' && item.id && item.testOnly !== true)
          .map((item) => ({
            id: item.id,
            label: typeof item.label === 'string' && item.label ? item.label : item.id,
            short: typeof item.short === 'string' && item.short ? item.short : item.id,
            // `ready` 只表示"有 Agent 执行适配器"。视图能不能显示由 kind/视图表决定，两者不混。
            ready: item.status === 'supported',
            // `view` 行（默认视图）不是目标环境：它没有开关，永远可选。
            kind: item.kind === 'view' ? 'view' : 'environment',
            status: typeof item.status === 'string' ? item.status : 'planned',
          }));
        return rows.length ? rows : [{ id: 'default', label: '默认视图', short: '默认', ready: false, kind: 'view', status: 'empty' }];
      }, [hostConfig.state.catalog]);
      /**
       * 组合框列出**空态视图 + 开关已打开的目标环境**（`environments.<id>.enabled`）。
       *
       * - 默认视图永远在：它是"没有目标"的合法落点，也是所有环境都关闭时唯一的选项。
       * - 其他环境只看自己的开关，不再看"是否实现"：3D 这类只有视图的环境同样可以被选中并持久化。
       * - 宿主配置还没读到时按可执行集合 + 默认视图兜底，免得一上来列表是空的。
       */
      const envEnabledList = React.useMemo(() => ENVIRONMENTS
        .map((option) => {
          if (option.kind === 'view') return Object.assign({}, option, { enabled: true });
          const fromConfig = enabledFromConfig(hostConfig.state.config, option.id);
          const enabled = fromConfig === null
            ? (option.id === 'web' || (allowedEnvironments ? allowedEnvironments.indexOf(option.id) !== -1 : false))
            : fromConfig;
          return Object.assign({}, option, { enabled });
        })
        .filter((option) => option.enabled), [ENVIRONMENTS, hostConfig.state.config, allowedEnvironments]);
      const envOptions = React.useMemo(() => (envEnabledList.length
        ? envEnabledList
        : ENVIRONMENTS.filter((option) => option.kind === 'view')
          .map((option) => Object.assign({}, option, { enabled: true }))),
      [envEnabledList, ENVIRONMENTS]);

      /**
       * 宿主解析出来的选择是唯一真值：会话/工作区存过什么就显示什么。
       *
       * 这里**不再**把面板往"宿主当前执行环境"拽——切到另一个工作区的会话时，那一边自己存着
       * 自己的选择，面板跟着它走即可，而不是被强制切到某个目标环境（docs/debug-panel.md）。
       */
      const resolvedView = (hostResolved && typeof hostResolved.view === 'string' && hostResolved.view)
        || resolvedEnvironment;
      React.useEffect(() => {
        if (!resolvedView) return;
        setEnv((current) => (current === resolvedView ? current : resolvedView));
      }, [resolvedView]);
      // 已存的选择被设置页关掉开关后，Host 会解析成默认视图：本地跟着落回空态，避免组合框里
      // 显示一个已经不存在的选项。env 仍在选项表里时不动它（不打断用户正在看的东西）。
      React.useEffect(() => {
        if (envOptions.some((option) => option.id === env)) return;
        const fallback = envOptions.some((option) => option.id === resolvedView)
          ? resolvedView
          : ((envOptions.find((option) => option.kind === 'view') || envOptions[0] || {}).id || 'default');
        setEnv(fallback);
      }, [envOptions, env, resolvedView]);
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
        if (!envHasTabs(tabsEnvRef.current)) return;
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
        if (!envHasTabs(tabsEnvRef.current) || !stableViews || tabOpening) return;
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

      /**
       * 标签保活锁开关（仅人力）：Host 是唯一真相，本地不预判结果。
       * 成功时把锁标记写回缓存的 views（下一轮 /state 会再确认一次）；失败只提示，不改状态。
       */
      function toggleTabLock(view) {
        if (!envHasTabs(tabsEnvRef.current) || !view || typeof view.id !== 'string') return;
        const nextLocked = !(view.locked === true);
        const tabId = String(view.id);
        callHost('tabs', { action: nextLocked ? 'lock' : 'unlock', tabId }, { scope: scopeNowForView(view) })
          .then((payload) => {
            const confirmed = payload && typeof payload.locked === 'boolean' ? payload.locked : nextLocked;
            const current = stableViewsRef.current;
            if (!current) return;
            const views = current.views.map((item) => (String(item.id) === tabId ? { ...item, locked: confirmed } : item));
            stableViewsRef.current = { ...current, views };
            setTabsTick((value) => value + 1);
            showTabNotice(confirmed ? '已锁定：该标签不会被自动回收' : '已解除锁定：该标签恢复自动回收');
          })
          .catch((error) => {
            const code = String((error && error.code) || '');
            showTabNotice(code === 'TAB_NOT_FOUND'
              ? '标签已经关闭，无法切换保活锁'
              : '切换保活锁失败，请稍后重试');
          });
      }

      /** The lock is addressed by the tab's own runtime binding, exactly like /close. */
      function scopeNowForView(view) {
        const runtimeId = String((view && view.runtimeId) || '');
        if (runtimeId) return scopeSnapshot('recent', '', runtimeId, false);
        return scopeRef.current;
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
        if (!envHasTabs(tabsEnvRef.current) || !view) return;
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
        if (!envHasFeature(env, 'devtools') || !running || devtools.available !== true) {
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
