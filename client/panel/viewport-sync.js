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
        // 空白画布（当前环境没有视图）：视口写入的目标已经不在这块面板上——丢弃本次合并补丁，
        // 对仍在运行的目标产生零视口写入（plan §公共面板负责组合）。
        if (!envHasViewRef.current) return;
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
        // Capture the panel instance this write belongs to: a response that arrives after the view
        // was replaced describes a view that is no longer on screen.
        const panelGeneration = panelGenerationRef.current;
        try {
          const payload = await callHost('viewport', body, { scope: scopeNow, signal });
          if (panelGeneration !== panelGenerationRef.current) return;
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

      /**
       * 页面声音开关（docs/web/debug-panel.md）。默认静音：Chrome 要求一次用户手势才能让
       * AudioContext 出声，所以"打开"必须来自这次点击本身，不能由代码自动触发。
       */
      function toggleAudio() {
        if (pageAudio.snapshot().enabled) {
          pageAudio.disable();
          setAudioState(pageAudio.snapshot());
          return;
        }
        pageAudio.enable().then(() => setAudioState(pageAudio.snapshot()), () => setAudioState(pageAudio.snapshot()));
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
