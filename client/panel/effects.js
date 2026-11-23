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
      const annotReady = blenderView ? (blenderStatus.phase === 'ready' || annotOn)
        : envHasView ? (viewSync && canvasOn) : true;
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
      // 无视图环境优先用空白画布映射：切换环境后运行态里可能残留 web 的旧帧（shot），
      // 若先判 canvasOn && shot 会走进页面几何推导并拿到 null，导致标注图层不可见。
      // 目标环境实现时把自己的映射注册进 ENV_ANNOT_MAP；没注册的环境走公共默认（空白视图窗）。
      const annotMapNow = resolveAnnotMap();
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
      const annotGateOpen = blenderView ? Boolean(blenderStatus.width)
        : annotGateRef.current.open && annotGateRef.current.epoch === scopeEpoch;
      const annotChannel = Boolean(annotContextNow());
      annotChannelRef.current = annotChannel;
      const annotSyncState = blenderView ? 'local' : !annotChannel ? 'unsupported' : (annotGateOpen ? annotSync.state : 'idle');
      const annotSyncRevision = annotGateOpen && Number.isFinite(Number(annotSync.revision))
        ? Math.max(0, Math.round(Number(annotSync.revision))) : 0;
      const annotStale = annotStaleState;
      const annotNavHint = '标注按工作区保留，导航/刷新会清除当前页面标注';
      const annotSyncText = blenderView ? (annotOn ? '面板标注' : '') : annotSyncState === 'unsupported'
        ? '标注未同步（宿主无标注通道）'
        : annotSyncState === 'error'
          ? '标注未同步'
          : annotSyncState === 'pending'
            ? '标注同步中…'
            : '';
      const annotSyncTitle = blenderView ? 'Blender 标注在本面板内保存，可随画面截图。' : (annotSyncState === 'unsupported'
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
        if (!annotOn || blenderView) return;
        // Running/runtime loss or a vanished canvas capability retracts the local view and exits;
        // unconfirmed content is remembered (not flushed into a capability that is gone).
        if (!running || !canvasOn) {
          annotRetainDirty(false);
          annotDropLocalView({ exit: true });
        }
      }, [annotOn, running, canvasOn, blenderView]);
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
