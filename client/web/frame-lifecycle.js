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
        // 依赖 env：切换环境会换掉 stage 节点（web 预览区 ↔ 无视图的空白视图窗），
        // 只在挂载时观察会让新节点的 room 一直是 0，视图窗就无法等比适应。
      }, [env]);

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
        // Only a view with a page polls the Host to discover a binding; a blank canvas never does.
        if (!visible || !envHasView || identity.kind !== 'recent' || binding || legacyHost) return undefined;
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

      /**
       * 视图实例自己持有通道（帧流 + 状态轮询 + 种子截图）：外壳只决定"现在有没有视图要显示"。
       *
       * 通道对象在实例生命周期内只创建一次，`mount()` 返回幂等的清理函数：切页/切环境/隐藏面板
       * 都会卸载旧通道（关 WS、停轮询、撤销 objectURL）。无视图环境（空白画布）根本不 mount，
       * 因此对仍在运行的目标零帧流、零截图、零轮询。
       */
      const viewChannelRef = React.useRef(null);
      if (!viewChannelRef.current) {
        viewChannelRef.current = createWebViewChannel({
          createFrameTransport,
          getHost,
          ingestHostState,
          discardBinding,
          scopeRef,
          visibleRef,
          writesPausedRef,
          requestGenerationRef,
          transportRef,
          frameMetaRef,
          shotUrlRef,
          setShot,
          setTransportKind,
          setSeedStatus,
          playPageAudio: (message) => pageAudio.push(message),
          // Leaving the view must not leave a key held down in the page.
          onBeforeUnmount: () => { try { releasePanelKeys(); } catch { /* ignore */ } },
        });
      }
      React.useEffect(() => {
        const unsubscribe = pageAudio.subscribe((next) => setAudioState(next));
        return () => { try { unsubscribe(); } catch { /* ignore */ } };
      }, [pageAudio]);
      // The "live" indicator needs a clock, not a packet: players stay silent while nothing plays.
      React.useEffect(() => {
        const timer = window.setInterval(() => setAudioState(pageAudio.snapshot()), 1000);
        return () => window.clearInterval(timer);
      }, [pageAudio]);
      React.useEffect(() => () => { try { pageAudio.close(); } catch { /* ignore */ } }, [pageAudio]);

      React.useEffect(() => {
        if (!visible || !ready || !envHasView) return undefined;
        return viewChannelRef.current.mount();
      }, [scopeEpoch, ready, visible, envHasView]);

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

      // React's delegated wheel listener is passive. Keep a native listener on the Web stage
      // itself, including when switching from the default view replaces the stage DOM node.
      const setWebStage = React.useMemo(() => {
        const listener = (event) => stageWheelRef.current?.(event);
        return (node) => {
          stage.current?.removeEventListener('wheel', listener);
          stage.current = node;
          node?.addEventListener('wheel', listener, { passive: false });
        };
      }, []);
      // Number fields also need non-passive wheel listeners so the panel controls their step.
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
          : code === 'INPUT_NOT_DELIVERED'
            ? '页面未收到完整输入，请检查当前标签的状态'
            : (error && error.message ? '输入发送失败：' + String(error.message) : '输入发送失败');
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
