      /** 入口可用条件（与按钮 disabled 同源）：运行中 + 就绪 + 视口 + 画布 + 标注/尺寸互斥。 */
      function pickAvailable() {
        const current = remoteRef.current;
        return Boolean(current && current.running === true && readyRef.current
          && viewRef.current && canvasRef.current
          && !annotRef.current.on && !sizingRef.current);
      }

      function pickSetStatus(text, kind) {
        setPickStatus({ text: String(text || ''), kind: kind || 'info' });
        window.clearTimeout(pickStatusTimerRef.current);
        pickStatusTimerRef.current = window.setTimeout(() => setPickStatus(null), PICK_STATUS_MS);
      }

      /** 只清悬浮框（保留模式）：递增序号让在途的过期响应失效。 */
      function pickClearOverlay() {
        const ref = pickRef.current;
        ref.hoverSeq += 1;
        ref.hoverQueued = false;
        if (ref.timer) {
          window.clearTimeout(ref.timer);
          ref.timer = 0;
        }
        // 一个待触发的滚动去抖不该在清框后把旧指针位置的框重新画回来。
        if (ref.wheelTimer) {
          window.clearTimeout(ref.wheelTimer);
          ref.wheelTimer = 0;
        }
        setPickOverlay(null);
      }

      function exitPickMode() {
        const ref = pickRef.current;
        if (!ref.on) return;
        ref.on = false;
        // 让所有在途响应（悬浮/详情）按序号与模式双重条件丢弃。
        ref.hoverSeq += 1;
        ref.detailSeq += 1;
        ref.hoverQueued = false;
        ref.hoverInflight = false;
        ref.detailInflight = false;
        if (ref.timer) {
          window.clearTimeout(ref.timer);
          ref.timer = 0;
        }
        if (ref.wheelTimer) {
          window.clearTimeout(ref.wheelTimer);
          ref.wheelTimer = 0;
        }
        // 页面输入无需显式恢复：派发路径按 pickRef.current.on 实时判定。
        setPickOn(false);
        setPickOverlay(null);
      }

      function enterPickMode() {
        const ref = pickRef.current;
        if (ref.on) return;
        // 与标注/尺寸调整互斥：任一在开时直接 no-op（程序化/键盘同一道闸）。
        if (annotRef.current.on || sizingRef.current) return;
        if (!pickAvailable()) return;
        // Raise the gate only after the active page drag released its button.
        if (dragRef.current.active) releaseFrameDrag();
        const panWrite = panWriteRef.current;
        if (panWrite.timer) {
          window.clearTimeout(panWrite.timer);
          panWrite.timer = 0;
        }
        panWrite.latest = null;
        cancelPanDrag();
        panModeRef.current = false;
        setPanMode(false);
        setPanDragging(false);
        clearZoomIntent();
        resetZoomAnchor();
        setMenu(false);
        ref.on = true;
        ref.lastClient = null;
        ref.hoverQueued = false;
        setPickStatus(null);
        setPickOverlay(null);
        setPickOn(true);
      }

      function togglePickMode() {
        if (pickRef.current.on) exitPickMode();
        else enterPickMode();
      }

      /** 悬浮命中节流（≥80ms 间隔）并合并到最新指针位置；单飞，在途时只记一个待办。 */
      function pickScheduleHover(clientX, clientY) {
        const ref = pickRef.current;
        if (!ref.on) return;
        if (Number.isFinite(Number(clientX)) && Number.isFinite(Number(clientY))) {
          ref.lastClient = { x: Number(clientX), y: Number(clientY) };
        }
        if (!ref.lastClient || ref.detailInflight) return;
        if (ref.hoverInflight || ref.timer) {
          ref.hoverQueued = true;
          return;
        }
        const wait = PICK_HOVER_MS - (Date.now() - ref.lastAt);
        if (wait <= 0) {
          pickRequestHover();
          return;
        }
        ref.timer = window.setTimeout(() => {
          ref.timer = 0;
          pickRequestHover();
        }, wait);
      }

      function pickRequestHover() {
        const ref = pickRef.current;
        if (!ref.on || ref.hoverInflight || ref.detailInflight || !ref.lastClient) return;
        const geom = frameGeometry();
        if (!geom) return;
        const point = mapEventPoint({ clientX: ref.lastClient.x, clientY: ref.lastClient.y }, geom);
        if (!point.inside || point.blank) {
          pickClearOverlay();
          return;
        }
        const canvas = canvasPosition();
        if (!canvas) return;
        const requestC = { x: Number(canvas.x), y: Number(canvas.y) };
        const epoch = scopeEpochRef.current;
        const seq = ref.hoverSeq + 1;
        ref.hoverSeq = seq;
        ref.hoverInflight = true;
        ref.hoverQueued = false;
        ref.lastAt = Date.now();
        callHost('element', { x: point.q.x + canvas.x, y: point.q.y + canvas.y, detail: false }, {
          scope: scopeRef.current,
          signal: abortRef.current ? abortRef.current.signal : undefined,
        }).then((payload) => {
          if (scopeEpochRef.current !== epoch || !ref.on || ref.hoverSeq !== seq) return;
          // C 是框坐标的基准：响应回来时画布原点已移动（滚动/平移/Agent 改视口）→ 丢弃这次框，
          // 按最后一次指针位置重取，绝不画出错位的框。
          const current = canvasPosition();
          if (!current
            || Math.abs(Number(current.x) - requestC.x) > 0.5
            || Math.abs(Number(current.y) - requestC.y) > 0.5) {
            ref.hoverSeq += 1;
            setPickOverlay(null);
            if (ref.on) pickScheduleHover();
            return;
          }
          setPickOverlay(pickOverlayOf(payload && payload.element));
        }).catch(() => {
          if (scopeEpochRef.current !== epoch || !ref.on || ref.hoverSeq !== seq) return;
          setPickOverlay(null);
        }).finally(() => {
          ref.hoverInflight = false;
          if (ref.on && ref.hoverQueued) pickScheduleHover();
        });
      }

      /** 滚轮仍滚动目标页；滚动稳定（180ms 去抖）后按最后指针位置重取悬浮命中。 */
      function pickAfterWheel(clientX, clientY) {
        const ref = pickRef.current;
        if (!ref.on) return;
        ref.lastClient = { x: clientX, y: clientY };
        if (ref.wheelTimer) window.clearTimeout(ref.wheelTimer);
        ref.wheelTimer = window.setTimeout(() => {
          ref.wheelTimer = 0;
          if (ref.on) pickScheduleHover();
        }, PICK_WHEEL_DEBOUNCE_MS);
      }

      /**
       * 把文本块追加到 DSH 聊天框末尾。child tab 的 identity 不是聊天对象，始终用 baseIdentity。
       *
       * 公开路径是 `conversation.input.requestDraftInitialization(binding, {whenDraftExists:'append'})`：
       * 空草稿 setDraft(text)，非空走编辑器 appendDraft（新段落追加、保留 @引用 chip/quote）。
       * 注意 `shell.appendDraft` 不是公开面（SessionInputShell 上没有），因此绝不用 setDraft 拼接
       * 作为降级——那会丢掉 chip/quote；接口缺失/未 retain 一律明确 unavailable。
       * 返回 {ok} 或 {ok:false, reason: no-session|unavailable|busy|error}。
       */
      function pickAppendToChat(text) {
        const sid = baseIdentity && baseIdentity.kind === 'session' ? String(baseIdentity.sessionId || '') : '';
        if (!sid) return { ok: false, reason: 'no-session' };
        const ctx = pluginContext;
        if (!ctx || typeof ctx.get !== 'function') return { ok: false, reason: 'unavailable' };
        let sessions = null;
        let input = null;
        try {
          sessions = ctx.get('sessions');
          const conversation = ctx.get('conversation');
          input = conversation && conversation.input;
        } catch {
          return { ok: false, reason: 'unavailable' };
        }
        if (!input || typeof input.requestDraftInitialization !== 'function') return { ok: false, reason: 'unavailable' };
        if (!sessions || typeof sessions.binding !== 'function') return { ok: false, reason: 'unavailable' };
        // 只有已 retain 的 Session 才有 binding；未 retain 不 materialize（那是会话控制器的职责）。
        let binding = null;
        try {
          binding = sessions.binding(sid);
        } catch {
          binding = null;
        }
        if (!binding) return { ok: false, reason: 'not-retained' };
        let result = null;
        try {
          result = input.requestDraftInitialization(binding, { prompt: text, whenDraftExists: 'append' });
        } catch {
          // 同步 throw = binding 代次已失效（会话切换/retain 被释放）。
          return { ok: false, reason: 'stale-binding' };
        }
        // blocked = disposed 或 phase ∈ {adjudicating, submitting, sending}；preserved 不该出现（append）。
        if (result === 'blocked') return { ok: false, reason: 'busy' };
        if (result !== 'applied') return { ok: false, reason: 'unavailable' };
        // 焦点 best-effort：把键盘还给该会话的 composer（拿不到就静默忽略）。
        try {
          const face = typeof input.for === 'function' ? input.for(binding.ctx) : null;
          if (face && typeof face.focus === 'function') face.focus();
        } catch { /* focus 是 best-effort */ }
        return { ok: true };
      }

      /** pointerdown：用当下坐标重新 detail:true 命中（绝不复用可能过期的悬浮结果）。 */
      function pickCommitAt(event) {
        const ref = pickRef.current;
        if (!ref.on || ref.detailInflight) return;
        const geom = frameGeometry();
        if (!geom) return;
        const point = mapEventPoint(event, geom);
        if (!point.inside) return;
        if (point.blank) {
          showBlankHint();
          return;
        }
        const canvas = canvasPosition();
        if (!canvas) return;
        const epoch = scopeEpochRef.current;
        const seq = ref.detailSeq + 1;
        ref.detailSeq = seq;
        ref.detailInflight = true;
        callHost('element', { x: point.q.x + canvas.x, y: point.q.y + canvas.y, detail: true }, {
          scope: scopeRef.current,
          signal: abortRef.current ? abortRef.current.signal : undefined,
        }).then((payload) => {
          if (scopeEpochRef.current !== epoch || !ref.on || ref.detailSeq !== seq) return;
          const element = payload && payload.element;
          if (!element) {
            pickSetStatus('未命中页面元素（页面可能已变化）', 'error');
            return;
          }
          const sessionId = baseIdentity && baseIdentity.kind === 'session' ? String(baseIdentity.sessionId || '') : '';
          const elementPayload = pickElementPayload(element, activeUrl);
          const locator = pickCollapseText(element.selector) || pickCompoundSelector(element);
          const chip = pickInsertElementChip(sessionId, elementPayload);
          if (chip.ok) {
            elementRefRemember(sessionId, elementPayload);
            pickSetStatus('已加入聊天框（引用）：' + locator, 'ok');
            exitPickMode();
            return;
          }
          // 降级：chip 不可插入（服务缺失/未 retain/忙）时仍把完整块追加为纯文本，并如实标注。
          const appended = pickAppendToChat(pickElementModelText(elementPayload));
          if (!appended.ok) {
            pickSetStatus(pickChatFailureText(appended.reason), 'error');
            return;
          }
          elementRefRemember(sessionId, elementPayload);
          pickSetStatus('已加入聊天框（文本）：' + locator + (chip.reason ? '（引用不可用：' + chip.reason + '）' : ''), 'ok');
          exitPickMode();
        }).catch((error) => {
          if (scopeEpochRef.current !== epoch || !ref.on || ref.detailSeq !== seq) return;
          if (error && error.name === 'AbortError') return;
          pickSetStatus(pickElementFailureText(error), 'error');
        }).finally(() => {
          if (ref.detailSeq !== seq) return;
          ref.detailInflight = false;
          if (ref.on && ref.hoverQueued) pickScheduleHover();
        });
      }

      function chooseAnnotTool(tool) {
        if (!annotRef.current.on || tool === annotRef.current.tool) return;
        cancelAnnotDraft();
        cancelAnnotMove();
        cancelAnnotMarquee();
        annotSetHoverCursor(tool === 'marquee' ? 'crosshair' : 'default');
        if (annotEditRef.current.active) commitAnnotText();
        // 切回绘制/橡皮擦/文字时清空选择；选择 ↔ 框选之间保留，方便先点选再框选追加。
        if (!annotIsSelectionTool(tool)) annotClearSelection();
        annotRef.current.tool = tool;
        const style = annotStyleFor(tool, annotRef.current.mode || 'stroke');
        annotRef.current.fill = style.fill;
        annotRef.current.stroke = style.stroke;
        setAnnotTool(tool);
      }

      function changeAnnotStyle(patch) {
        if (!annotRef.current.on) return;
        cancelAnnotDraft();
        if (annotEditRef.current.active) commitAnnotText();
        Object.assign(annotRef.current, patch);
        if (patch.color !== undefined) setAnnotColor(patch.color);
        if (patch.width !== undefined) setAnnotWidth(patch.width);
      }

      /**
       * 用户 2026-11-03 第 1 条：填充/外框分页选择器。恰好一个选中；点已选项完全 no-op
       * （在 cancel/commit 等副作用之前返回）。只有圆形/矩形可切换，其它工具整组 disabled。
       */
      function changeAnnotStyleMode(next) {
        const current = annotRef.current;
        if (!current.on || !annotIsClosedTool(current.tool) || next === current.mode) return;
        cancelAnnotDraft();
        if (annotEditRef.current.active) commitAnnotText();
        current.mode = next;
        const style = annotStyleFor(current.tool, next);
        current.fill = style.fill;
        current.stroke = style.stroke;
        setAnnotStyleMode(next);
      }

      function annotTextKey(event) {
        // IME composition owns Enter/Escape; keyCode 229 is the composition placeholder.
        if (event.keyCode === 229 || annotComposingRef.current || (event.nativeEvent && event.nativeEvent.isComposing)) return;
        if (event.key === 'Enter') {
          event.preventDefault();
          commitAnnotText();
          return;
        }
        if (event.key === 'Escape') {
          event.preventDefault();
          cancelAnnotText();
        }
      }

      /** Committed shape → React SVG node. Geometry data lives on the root g; native geometry on
       * the child element, so data, SVG and screen position can all be checked independently.
       * `extra` is used by the selection halo (same geometry, accent styling, no committed state). */
      function renderAnnotShape(shape, extra) {
        const common = Object.assign({
          key: shape.id,
          'data-utb-annot-id': shape.id,
          'data-utb-annot-type': shape.type,
          'data-utb-annot-state': 'committed',
          'data-utb-annot-color': shape.color,
          'data-utb-annot-stroke-width': String(shape.strokeWidth),
          'data-utb-annot-fill': shape.fill ? 'true' : 'false',
          'data-utb-annot-stroke': shape.stroke ? 'true' : 'false',
          style: { pointerEvents: 'none' },
        }, extra || {});
        if (shape.type === 'circle') {
          return h('g', Object.assign({}, common, {
            'data-utb-annot-cx': String(shape.cx),
            'data-utb-annot-cy': String(shape.cy),
            'data-utb-annot-rx': String(shape.rx),
            'data-utb-annot-ry': String(shape.ry),
          }), h('ellipse', {
            cx: shape.cx, cy: shape.cy, rx: shape.rx, ry: shape.ry,
            fill: shape.fill ? shape.color : 'none',
            stroke: shape.stroke ? shape.color : 'none',
            strokeWidth: shape.stroke ? shape.strokeWidth : 0,
          }));
        }
        if (shape.type === 'rect') {
          return h('g', Object.assign({}, common, {
            'data-utb-annot-x': String(shape.x),
            'data-utb-annot-y': String(shape.y),
            'data-utb-annot-width': String(shape.w),
            'data-utb-annot-height': String(shape.h),
          }), h('rect', {
            x: shape.x, y: shape.y, width: shape.w, height: shape.h,
            fill: shape.fill ? shape.color : 'none',
            stroke: shape.stroke ? shape.color : 'none',
            strokeWidth: shape.stroke ? shape.strokeWidth : 0,
          }));
        }
        if (shape.type === 'line') {
          return h('g', Object.assign({}, common, {
            'data-utb-annot-x1': String(shape.x1),
            'data-utb-annot-y1': String(shape.y1),
            'data-utb-annot-x2': String(shape.x2),
            'data-utb-annot-y2': String(shape.y2),
          }), h('line', {
            x1: shape.x1, y1: shape.y1, x2: shape.x2, y2: shape.y2,
            fill: 'none', stroke: shape.color, strokeWidth: shape.strokeWidth, strokeLinecap: 'round',
          }));
        }
        if (shape.type === 'arrow') {
          const geometry = annotArrowGeometry({ x: shape.x1, y: shape.y1 }, { x: shape.x2, y: shape.y2 }, shape.strokeWidth);
          const base = geometry ? geometry.base : { x: shape.x2, y: shape.y2 };
          return h('g', Object.assign({}, common, {
            'data-utb-annot-x1': String(shape.x1),
            'data-utb-annot-y1': String(shape.y1),
            'data-utb-annot-x2': String(shape.x2),
            'data-utb-annot-y2': String(shape.y2),
            'data-utb-annot-head-length': geometry ? String(Math.min(3 * shape.strokeWidth, geometry.length)) : '0',
            'data-utb-annot-head-width': geometry ? String(Math.min(2 * shape.strokeWidth, geometry.length)) : '0',
          }), [
            h('line', {
              key: 'shaft', x1: shape.x1, y1: shape.y1, x2: base.x, y2: base.y,
              fill: 'none', stroke: shape.color, strokeWidth: shape.strokeWidth, strokeLinecap: 'round',
            }),
            h('polygon', {
              key: 'head',
              points: geometry ? annotPointsText(geometry.points) : '',
              fill: shape.color, stroke: 'none',
            }),
          ]);
        }
        if (shape.type === 'brush') {
          return h('g', Object.assign({}, common, {
            'data-utb-annot-points': JSON.stringify(shape.points),
          }), h('polyline', {
            points: annotPointsText(shape.points),
            fill: 'none', stroke: shape.color, strokeWidth: shape.strokeWidth,
            strokeLinecap: 'round', strokeLinejoin: 'round',
          }));
        }
        if (shape.type === 'text') {
          return h('g', Object.assign({}, common, {
            'data-utb-annot-x': String(shape.x),
            'data-utb-annot-y': String(shape.y),
            'data-utb-annot-font-size': '20',
          }), h('text', {
            x: shape.x, y: shape.y, fontSize: 20,
            fill: shape.color, stroke: 'none',
            fontFamily: 'system-ui, -apple-system, "Segoe UI", sans-serif',
            fontWeight: 400,
            dominantBaseline: 'text-before-edge',
          }, shape.text));
        }
        return null;
      }
