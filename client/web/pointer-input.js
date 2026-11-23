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
