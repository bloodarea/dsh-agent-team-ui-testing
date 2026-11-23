      /**
       * Real Path2D hit for rect/ellipse (§11.4): a hollow shape only hits on its stroke band, a
       * filled one hits its interior too; an ellipse never falls back to its bounding box.
       */
      function annotHitPath(shape, point, radius) {
        const context = annotHitContext();
        if (!context) return false;
        let path = null;
        try {
          path = new Path2D();
          if (shape.type === 'rect') path.rect(shape.x, shape.y, shape.w, shape.h);
          else path.ellipse(shape.cx, shape.cy, shape.rx, shape.ry, 0, 0, Math.PI * 2);
        } catch { return false; }
        if (shape.fill && context.isPointInPath(path, point.x, point.y)) return true;
        if (!shape.stroke) return false;
        context.lineWidth = radius * 2;
        return context.isPointInStroke(path, point.x, point.y);
      }

      /** Text uses the rendered `getBBox()` in canvas CSS px; unreadable bbox = no hit (no guessing). */
      function annotHitText(shape, point, padding = 0) {
        const svg = annotSvgRef.current;
        if (!svg) return false;
        const id = String(shape.id || '').replace(/["\\]/g, '');
        const node = svg.querySelector('g[data-utb-annot-id="' + id + '"] text');
        if (!node || typeof node.getBBox !== 'function') return false;
        let box = null;
        try { box = node.getBBox(); } catch { box = null; }
        if (!box || !(box.width > 0) || !(box.height > 0)) return false;
        return point.x >= box.x - padding && point.x <= box.x + box.width + padding
          && point.y >= box.y - padding && point.y <= box.y + box.height + padding;
      }

      function annotHitArrow(shape, point, radius) {
        const geometry = annotArrowGeometry({ x: shape.x1, y: shape.y1 }, { x: shape.x2, y: shape.y2 }, shape.strokeWidth);
        if (!geometry) return annotSegmentDistance(point, { x: shape.x1, y: shape.y1 }, { x: shape.x2, y: shape.y2 }) <= radius;
        if (annotSegmentDistance(point, { x: shape.x1, y: shape.y1 }, geometry.base) <= radius) return true;
        return annotPointInTriangle(point, geometry.points);
      }

      function annotHitsShape(shape, point, hitRadius) {
        const radius = hitRadius === undefined ? annotEraseRadius(shape) : hitRadius;
        if (shape.type === 'rect' || shape.type === 'circle') return annotHitPath(shape, point, radius);
        if (shape.type === 'text') return annotHitText(shape, point, hitRadius === undefined ? 0 : radius);
        if (shape.type === 'arrow') {
          if (annotHitArrow(shape, point, radius)) return true;
          if (hitRadius === undefined) return false;
          const geometry = annotArrowGeometry({ x: shape.x1, y: shape.y1 }, { x: shape.x2, y: shape.y2 }, shape.strokeWidth);
          return Boolean(geometry && geometry.points.some((a, index, points) =>
            annotSegmentDistance(point, a, points[(index + 1) % points.length]) <= radius));
        }
        if (shape.type === 'line') {
          return annotSegmentDistance(point, { x: shape.x1, y: shape.y1 }, { x: shape.x2, y: shape.y2 }) <= radius;
        }
        if (shape.type === 'brush') {
          const points = shape.points || [];
          if (points.length === 1) return Math.hypot(point.x - points[0].x, point.y - points[0].y) <= radius;
          for (let index = 1; index < points.length; index += 1) {
            if (annotSegmentDistance(point, points[index - 1], points[index]) <= radius) return true;
          }
          return false;
        }
        return false;
      }

      function resetAnnotErase() {
        const erase = annotEraseRef.current;
        const svg = annotSvgRef.current;
        if (erase.active && svg && erase.pointerId >= 0) {
          try { svg.releasePointerCapture(erase.pointerId); } catch { /* ignore */ }
        }
        annotEraseRef.current = { active: false, pointerId: -1, map: null, last: null, changed: 0 };
      }

      /* ---- 选择 / 框选（v3）----------------------------------------------------------------
       * 选中集合只属于本面板：不写 Host 文档、不改变 SVG 图形的数据属性之外的任何事实。
       * 点选用屏幕空间容差命中最上层图形；框选以手势开始时的集合为基准实时预览。
       * 只有「移动」与「删除」会改图形并走既有的 150ms 合并上报；选中本身零上报。
       * ------------------------------------------------------------------------------------ */

      function annotSelectionRefresh() {
        setAnnotVersion((value) => value + 1);
      }

      /** Coalesce pointer-move re-renders to one per animation frame (move stays smooth). */
      function annotSelectionScheduleRender() {
        if (annotSelectionRafRef.current) return;
        annotSelectionRafRef.current = window.requestAnimationFrame(() => {
          annotSelectionRafRef.current = 0;
          annotSelectionRefresh();
        });
      }

      function annotSelectionCount() {
        return annotSelectionRef.current.size;
      }

      /** Click modifiers toggle; marquee modifiers use union/difference/intersection instead. */
      function annotSelectionMode(event) {
        if (event.shiftKey && event.altKey) return 'intersect';
        if (event.altKey) return 'subtract';
        if (event.shiftKey) return 'add';
        if (event.ctrlKey || event.metaKey) return 'toggle';
        return 'replace';
      }

      function annotApplySelection(ids, mode, base, scheduled) {
        const existing = new Set(annotShapesRef.current.map((shape) => shape.id));
        const hits = new Set(ids.filter((id) => existing.has(id)));
        const next = mode === 'replace' ? new Set() : new Set([...base].filter((id) => existing.has(id)));
        if (mode === 'intersect') {
          for (const id of next) if (!hits.has(id)) next.delete(id);
        } else {
          for (const id of hits) {
            if (mode === 'subtract' || (mode === 'toggle' && next.has(id))) next.delete(id);
            else next.add(id);
          }
        }
        const previous = annotSelectionRef.current;
        if (next.size === previous.size && [...next].every((id) => previous.has(id))) return;
        annotSelectionRef.current = next;
        if (scheduled) annotSelectionScheduleRender();
        else annotSelectionRefresh();
      }

      function annotSetSelection(ids, additive) {
        annotApplySelection(ids, additive ? 'toggle' : 'replace', annotSelectionRef.current, false);
      }

      function annotClearSelection() {
        if (!annotSelectionRef.current.size) return;
        annotSelectionRef.current = new Set();
        annotSelectionRefresh();
      }

      /** Drop ids the current document no longer contains (import/erase/clear). */
      function annotPruneSelection() {
        if (!annotSelectionRef.current.size) return;
        const existing = new Set(annotShapesRef.current.map((shape) => shape.id));
        let changed = false;
        for (const id of Array.from(annotSelectionRef.current)) {
          if (!existing.has(id)) { annotSelectionRef.current.delete(id); changed = true; }
        }
        if (changed) annotSelectionRefresh();
      }

      /** Analytic bbox in canvas CSS px (text uses the rendered getBBox, else a conservative estimate). */
      function annotShapeBounds(shape) {
        const move = annotMoveRef.current;
        const base = move.active && move.bounds && move.bounds.get(shape.id);
        if (base) return { x: base.x + move.dx, y: base.y + move.dy, w: base.w, h: base.h };
        const width = Number(shape.strokeWidth);
        const pad = (Number.isFinite(width) && width > 0 ? width : 1) / 2 + 1;
        if (shape.type === 'circle') {
          return { x: shape.cx - shape.rx - pad, y: shape.cy - shape.ry - pad, w: shape.rx * 2 + pad * 2, h: shape.ry * 2 + pad * 2 };
        }
        if (shape.type === 'rect') {
          return { x: shape.x - pad, y: shape.y - pad, w: shape.w + pad * 2, h: shape.h + pad * 2 };
        }
        if (shape.type === 'line' || shape.type === 'arrow') {
          const points = [{ x: shape.x1, y: shape.y1 }, { x: shape.x2, y: shape.y2 }];
          if (shape.type === 'arrow') {
            const geometry = annotArrowGeometry(points[0], points[1], shape.strokeWidth);
            if (geometry) points.push(...geometry.points);
          }
          const x = Math.min(...points.map((point) => point.x)) - pad;
          const y = Math.min(...points.map((point) => point.y)) - pad;
          return { x, y,
            w: Math.max(...points.map((point) => point.x)) - x + pad,
            h: Math.max(...points.map((point) => point.y)) - y + pad };
        }
        if (shape.type === 'brush') {
          const points = shape.points || [];
          if (!points.length) return null;
          let x1 = Infinity; let y1 = Infinity; let x2 = -Infinity; let y2 = -Infinity;
          for (const point of points) {
            x1 = Math.min(x1, point.x); y1 = Math.min(y1, point.y);
            x2 = Math.max(x2, point.x); y2 = Math.max(y2, point.y);
          }
          return { x: x1 - pad, y: y1 - pad, w: x2 - x1 + pad * 2, h: y2 - y1 + pad * 2 };
        }
        if (shape.type === 'text') {
          const svg = annotSvgRef.current;
          if (svg) {
            const id = String(shape.id || '').replace(/["\\]/g, '');
            const node = svg.querySelector('g[data-utb-annot-id="' + id + '"] text');
            if (node && typeof node.getBBox === 'function') {
              try {
                const box = node.getBBox();
                if (box.width > 0 && box.height > 0) return {
                  // During React render the DOM may still contain the previous position.
                  x: box.x + shape.x - Number(node.getAttribute('x')),
                  y: box.y + shape.y - Number(node.getAttribute('y')),
                  w: box.width, h: box.height,
                };
              } catch { /* fall through to the estimate */ }
            }
          }
          // Conservative estimate (CJK ≈ 1em, ASCII ≈ 0.5em) so a box selection still catches the text.
          const text = String(shape.text || '');
          let estimated = 0;
          for (const char of text) estimated += /[\u2e80-\u9fff\uf900-\ufaff\uff00-\uffef]/u.test(char) ? 20 : 10;
          return { x: shape.x, y: shape.y, w: Math.max(estimated, 20), h: 20 };
        }
        return null;
      }

      function annotRectIntersects(a, b) {
        return a.x < b.x + b.w && a.x + a.w > b.x && a.y < b.y + b.h && a.y + a.h > b.y;
      }

      /** Keep thin strokes easy to select at every zoom; eraser tolerance stays unchanged. */
      function annotTopmostAt(point, map) {
        const shapes = annotShapesRef.current;
        const scale = map ? Math.max(0.01, Math.min(map.sx, map.sy)) : 1;
        for (let index = shapes.length - 1; index >= 0; index -= 1) {
          const shape = shapes[index];
          const radius = Math.max(Number(shape.strokeWidth || 1) / 2, 6 / scale);
          if (annotHitsShape(shape, point, radius)) return shape;
        }
        return null;
      }

      /** Union bounding box of the selected shapes (null when nothing is selected). */
      function annotSelectionBounds() {
        if (!annotSelectionRef.current.size) return null;
        let x1 = Infinity; let y1 = Infinity; let x2 = -Infinity; let y2 = -Infinity;
        for (const shape of annotShapesRef.current) {
          if (!annotSelectionRef.current.has(shape.id)) continue;
          const box = annotShapeBounds(shape);
          if (!box) continue;
          x1 = Math.min(x1, box.x); y1 = Math.min(y1, box.y);
          x2 = Math.max(x2, box.x + box.w); y2 = Math.max(y2, box.y + box.h);
        }
        if (!(x2 >= x1) || !(y2 >= y1)) return null;
        return { x: x1, y: y1, w: x2 - x1, h: y2 - y1 };
      }

      /**
       * Inside the selection's union box. This is what makes selected shapes draggable from their
       * interior (a hollow rect's stroke-only hit test would miss) and lets a marquee-selected
       * group be dragged from the gap between its members.
       */
      function annotSelectionContains(point) {
        const box = annotSelectionBounds();
        return Boolean(box && point.x >= box.x && point.x <= box.x + box.w
          && point.y >= box.y && point.y <= box.y + box.h);
      }

      /** Translate one shape by a canvas-space delta (all six geometries; no style change). */
      function annotTranslateShape(shape, dx, dy) {
        if (!dx && !dy) return shape;
        if (shape.type === 'circle') return Object.assign({}, shape, { cx: shape.cx + dx, cy: shape.cy + dy });
        if (shape.type === 'rect') return Object.assign({}, shape, { x: shape.x + dx, y: shape.y + dy });
        if (shape.type === 'line' || shape.type === 'arrow') {
          return Object.assign({}, shape, {
            x1: shape.x1 + dx, y1: shape.y1 + dy, x2: shape.x2 + dx, y2: shape.y2 + dy,
          });
        }
        if (shape.type === 'brush') {
          return Object.assign({}, shape, { points: (shape.points || []).map((point) => ({ x: point.x + dx, y: point.y + dy })) });
        }
        if (shape.type === 'text') return Object.assign({}, shape, { x: shape.x + dx, y: shape.y + dy });
        return shape;
      }

      function annotSelectionOrigin() {
        const ids = annotSelectionRef.current;
        return annotShapesRef.current
          .filter((shape) => ids.has(shape.id))
          .map((shape) => ({ id: shape.id, shape }));
      }

      function annotStartMove(map, event, point) {
        const origin = annotSelectionOrigin();
        if (!origin.length) return false;
        annotMarqueeRef.current = { active: false, pointerId: -1, map: null, start: null, end: null, node: null };
        annotMoveRef.current = {
          active: true, pointerId: event.pointerId, map, start: point, last: point, origin,
          originals: new Map(origin.map((item) => [item.id, item.shape])),
          bounds: new Map(origin.map((item) => [item.id, annotShapeBounds(item.shape)])),
          dragging: false, axis: null, dx: 0, dy: 0, changed: false,
        };
        annotMapSigRef.current = annotMapSignature(map);
        const svg = annotSvgRef.current;
        try { if (svg) svg.setPointerCapture(event.pointerId); } catch { /* ignore */ }
        setAnnotBusy(true);
        return true;
      }

      function moveAnnotSelection(event) {
        const move = annotMoveRef.current;
        if (!move.active) return;
        const point = annotToCanvasRaw(move.map, event.clientX, event.clientY);
        move.last = point;
        let dx = point.x - move.start.x;
        let dy = point.y - move.start.y;
        const screen = Math.hypot(dx * move.map.sx, dy * move.map.sy);
        // Latch once: after a real drag, returning to the press point must restore the original.
        if (!move.dragging && screen < 4) return;
        move.dragging = true;
        if (event.shiftKey) {
          if (!move.axis) move.axis = Math.abs(dx * move.map.sx) >= Math.abs(dy * move.map.sy) ? 'x' : 'y';
          if (move.axis === 'x') dy = 0;
          else dx = 0;
        } else move.axis = null;
        if (dx === move.dx && dy === move.dy) return;
        move.dx = dx;
        move.dy = dy;
        move.changed = Boolean(dx || dy);
        annotShapesRef.current = annotShapesRef.current.map((shape) => {
          const base = move.originals.get(shape.id);
          return base ? annotTranslateShape(base, dx, dy) : shape;
        });
        annotSetHoverCursor('grabbing');
        annotSelectionScheduleRender();
      }

      function finishAnnotMove() {
        const move = annotMoveRef.current;
        if (!move.active) return;
        const svg = annotSvgRef.current;
        try { if (svg) svg.releasePointerCapture(move.pointerId); } catch { /* ignore */ }
        const changed = move.changed;
        annotMoveRef.current = { active: false, pointerId: -1, map: null, start: null, last: null, origin: null, changed: false };
        if (move.acceptedShapes) {
          annotApplyImported(move.acceptedShapes);
          if (changed) annotShapesRef.current = annotShapesRef.current.map((shape) => move.originals.has(shape.id)
            ? annotTranslateShape(shape, move.dx, move.dy) : shape);
        }
        setAnnotBusy(false);
        if (changed) {
          annotContentSeqRef.current += 1;
          annotDirtyRef.current = true;
          annotPublishSchedule();
        }
        if (!move.dragging && move.toggleOnClick) annotSetSelection([move.toggleOnClick], true);
        annotSetHoverCursor('move');
        annotSelectionRefresh();
        annotResumeAfterTransient();
      }

      /** Roll back a move gesture to the shapes captured at pointerdown; no publish happens. */
      function cancelAnnotMove() {
        const move = annotMoveRef.current;
        if (!move.active) return;
        const origin = new Map((move.origin || []).map((item) => [item.id, item.shape]));
        annotShapesRef.current = annotShapesRef.current.map((shape) => origin.get(shape.id) || shape);
        const svg = annotSvgRef.current;
        try { if (svg) svg.releasePointerCapture(move.pointerId); } catch { /* ignore */ }
        annotMoveRef.current = { active: false, pointerId: -1, map: null, start: null, last: null, origin: null, changed: false };
        if (move.acceptedShapes) annotApplyImported(move.acceptedShapes);
        if (annotSelectionRafRef.current) {
          window.cancelAnimationFrame(annotSelectionRafRef.current);
          annotSelectionRafRef.current = 0;
        }
        setAnnotBusy(false);
        annotSelectionRefresh();
        annotResumeAfterTransient();
      }

      function annotMarqueeRect(marquee) {
        const start = marquee.start || { x: 0, y: 0 };
        const end = marquee.end || start;
        return {
          x: Math.min(start.x, end.x), y: Math.min(start.y, end.y),
          w: Math.abs(end.x - start.x), h: Math.abs(end.y - start.y),
        };
      }

      /** The marquee preview lives in the imperative draft group (no React render per move). */
      function annotMarqueeNode() {
        const marquee = annotMarqueeRef.current;
        if (marquee.node && marquee.node.isConnected) return marquee.node;
        const draft = annotDraftRef.current;
        if (!draft) return null;
        const node = annotDraftNode('rect', { x: 0, y: 0, width: 0, height: 0, fill: 'none' });
        node.setAttribute('class', 'utb-annot-marquee-box');
        node.setAttribute('data-utb-annot-marquee', 'true');
        draft.appendChild(node);
        marquee.node = node;
        return node;
      }

      function renderAnnotMarquee() {
        const marquee = annotMarqueeRef.current;
        if (!marquee.active) return;
        const node = annotMarqueeNode();
        if (!node) return;
        const rect = annotMarqueeRect(marquee);
        node.setAttribute('x', String(rect.x));
        node.setAttribute('y', String(rect.y));
        node.setAttribute('width', String(rect.w));
        node.setAttribute('height', String(rect.h));
      }

      function startAnnotMarquee(map, event, point) {
        cancelAnnotMove();
        resetAnnotMarquee();
        cancelAnnotDraft();
        annotMarqueeRef.current = {
          active: true, pointerId: event.pointerId, map, start: point, end: point,
          mode: annotSelectionMode(event), base: new Set(annotSelectionRef.current), dragging: false,
          // Cache bounds once; text getBBox and stroke geometry need not run on every pointermove.
          boxes: annotShapesRef.current.map((shape) => ({ id: shape.id, box: annotShapeBounds(shape) })),
          node: null,
        };
        annotMapSigRef.current = annotMapSignature(map);
        const svg = annotSvgRef.current;
        try { if (svg) svg.setPointerCapture(event.pointerId); } catch { /* ignore */ }
        setAnnotBusy(true);
      }

      function moveAnnotMarquee(event) {
        const marquee = annotMarqueeRef.current;
        if (!marquee.active) return;
        marquee.end = annotToCanvasRaw(marquee.map, event.clientX, event.clientY);
        const rect = annotMarqueeRect(marquee);
        if (!marquee.dragging && Math.hypot(rect.w * marquee.map.sx, rect.h * marquee.map.sy) < 4) return;
        marquee.dragging = true;
        marquee.mode = annotSelectionMode(event);
        renderAnnotMarquee();
        const ids = marquee.boxes.filter((item) => item.box && annotRectIntersects(item.box, rect)).map((item) => item.id);
        annotApplySelection(ids, marquee.mode, marquee.base, true);
        if (marquee.node) marquee.node.setAttribute('data-utb-annot-marquee-mode', marquee.mode);
        annotSetHoverCursor('crosshair');
      }

      function resetAnnotMarquee() {
        const marquee = annotMarqueeRef.current;
        const svg = annotSvgRef.current;
        if (marquee.active && svg && marquee.pointerId >= 0) {
          try { svg.releasePointerCapture(marquee.pointerId); } catch { /* ignore */ }
        }
        if (marquee.node && marquee.node.parentNode) marquee.node.parentNode.removeChild(marquee.node);
        annotMarqueeRef.current = { active: false, pointerId: -1, map: null, start: null, end: null, node: null };
      }

      function finishAnnotMarquee() {
        const marquee = annotMarqueeRef.current;
        if (!marquee.active) return;
        // Preview is already the final set. A modified empty click preserves the base selection.
        if (!marquee.dragging) annotApplySelection([], marquee.mode === 'replace' ? 'replace' : 'add', marquee.base, false);
        resetAnnotMarquee();
        clearAnnotDraftNode();
        setAnnotBusy(false);
        annotSelectionRefresh();
        annotResumeAfterTransient();
      }

      function cancelAnnotMarquee() {
        const marquee = annotMarqueeRef.current;
        if (!marquee.active) return;
        annotSelectionRef.current = new Set(marquee.base);
        resetAnnotMarquee();
        clearAnnotDraftNode();
        setAnnotBusy(false);
        annotSelectionRefresh();
        annotResumeAfterTransient();
      }

      /** Delete every selected shape (one document change, one coalesced publish). */
      function annotDeleteSelection() {
        if (!annotRef.current.on) return false;
        cancelAnnotMove();
        cancelAnnotMarquee();
        if (!annotSelectionRef.current.size) return false;
        const ids = annotSelectionRef.current;
        const before = annotShapesRef.current.length;
        annotShapesRef.current = annotShapesRef.current.filter((shape) => !ids.has(shape.id));
        annotSelectionRef.current = new Set();
        const removed = before - annotShapesRef.current.length;
        if (removed > 0) {
          annotContentSeqRef.current += 1;
          annotDirtyRef.current = true;
          annotPublishSchedule();
        }
        annotSelectionRefresh();
        return removed > 0;
      }

      /** One sample point deletes the topmost hit only (no distance re-ranking, no drill-through). */
      function annotEraseAt(point) {
        const shapes = annotShapesRef.current;
        for (let index = shapes.length - 1; index >= 0; index -= 1) {
          if (annotHitsShape(shapes[index], point)) {
            annotShapesRef.current = shapes.slice(0, index).concat(shapes.slice(index + 1));
            annotEraseRef.current.changed += 1;
            annotPruneSelection();
            annotContentSeqRef.current += 1;
            annotDirtyRef.current = true;
            setAnnotVersion((value) => value + 1);
            return true;
          }
        }
        return false;
      }

      /** Unclamped canvas point through a frozen mapping (the eraser must not smear on the border). */
      function annotToCanvasRaw(map, clientX, clientY) {
        return {
          x: map.cx + (clientX - map.painted.left) / map.sx,
          y: map.cy + (clientY - map.painted.top) / map.sy,
        };
      }

      /** Only samples inside the visible canvas rect are erased (docs/viewport-control.md). */
      function annotInViewRect(map, point) {
        return point.x >= map.cx && point.x <= map.cx + map.w && point.y >= map.cy && point.y <= map.cy + map.h;
      }

      function startAnnotErase(map, event, point) {
        const svg = annotSvgRef.current;
        resetAnnotErase();
        annotEraseRef.current = { active: true, pointerId: event.pointerId, map, last: point, changed: 0 };
        annotMapSigRef.current = annotMapSignature(map);
        try { if (svg) svg.setPointerCapture(event.pointerId); } catch { /* ignore */ }
        // 按下即擦；无命中时不排任何上报（§12.3：无命中的橡皮擦零 POST）。
        if (annotEraseAt(point)) annotPublishSchedule();
      }

      function moveAnnotErase(event) {
        const erase = annotEraseRef.current;
        // 沿冻结映射取未 clamp 的画布点：拖出 P 时只处理与可见矩形相交的采样，不沿边界额外擦。
        const point = annotToCanvasRaw(erase.map, event.clientX, event.clientY);
        const last = erase.last || point;
        const dx = point.x - last.x;
        const dy = point.y - last.y;
        // 原地去重：同一坐标重复 move 不再采样（不会继续钻层）。
        if (Math.abs(dx) < 1e-6 && Math.abs(dy) < 1e-6) return;
        const steps = Math.max(1, Math.ceil(Math.hypot(dx, dy) / ANNOT_ERASE_STEP_PX));
        let erased = false;
        for (let index = 1; index <= steps; index += 1) {
          const sample = { x: last.x + (dx * index) / steps, y: last.y + (dy * index) / steps };
          if (!annotInViewRect(erase.map, sample)) continue;
          if (annotEraseAt(sample)) erased = true;
        }
        erase.last = point;
        if (erased) annotPublishSchedule();
      }

      function finishAnnotErase() {
        const erase = annotEraseRef.current;
        if (!erase.active) return;
        const changed = erase.changed;
        resetAnnotErase();
        if (changed) annotFlushPending(); // 结束 flush；擦掉的对象不因 cancel/Esc 回滚
      }

      /** 清除画布：清已完成 + 草稿/编辑，立即发布空文档，保留模式/工具/样式（§11.4）。 */
      /**
       * 标注栏「截图」：把**当前页面 + 已接受的标注**合成一张 PNG，作为附件放进聊天框。
       *
       * 语义边界（docs/viewport-control.md）：走 Host 的 `POST /screenshot {includeAnnotations:true}`，
       * 也就是 Agent 的 `browser_screenshot{includeAnnotations:true}` 同一条离屏合成路径，因此像素与
       * 证据完全一致，不是面板自己另画一遍 SVG。它沿用面板的 scope 身份；附件通过 Conversation 服务
       * 注册成 draft attachment（`createDrafts` + `addAttachments`），照片字节随消息发送，不落盘。
       */
      function annotShotTarget() {
        const sid = baseIdentity && baseIdentity.kind === 'session' ? String(baseIdentity.sessionId || '') : '';
        if (!sid) return { ok: false, reason: '当前面板没有绑定会话，无法加入聊天框附件' };
        const ctx = pluginContext;
        if (!ctx || typeof ctx.get !== 'function') return { ok: false, reason: '聊天框服务不可用' };
        let sessions = null;
        let conversation = null;
        try {
          sessions = ctx.get('sessions');
          conversation = ctx.get('conversation');
        } catch {
          return { ok: false, reason: '聊天框服务不可用' };
        }
        if (!conversation || typeof conversation.createDrafts !== 'function'
          || !conversation.input || typeof conversation.input.for !== 'function'
          || !sessions || typeof sessions.binding !== 'function') {
          return { ok: false, reason: '聊天框服务不可用' };
        }
        let binding = null;
        try { binding = sessions.binding(sid); } catch { binding = null; }
        if (!binding || !binding.ctx) return { ok: false, reason: '会话尚未就绪（未 retain），稍后再试' };
        let face = null;
        try { face = conversation.input.for(binding.ctx); } catch { face = null; }
        if (!face || typeof face.addAttachments !== 'function') return { ok: false, reason: '聊天框服务不可用' };
        return { ok: true, sid, conversation, face };
      }

      async function captureBlenderAnnotationShot() {
        const image = blenderImageRef.current;
        const layer = annotSvgRef.current;
        if (!image?.complete || !image.naturalWidth || !layer) throw new Error('Blender 视口还未就绪');
        const canvas = document.createElement('canvas');
        canvas.width = image.naturalWidth;
        canvas.height = image.naturalHeight;
        const context = canvas.getContext('2d');
        if (!context) throw new Error('画布不可用');
        context.drawImage(image, 0, 0);
        const svg = document.createElementNS(SVG_NS, 'svg');
        svg.setAttribute('width', String(canvas.width));
        svg.setAttribute('height', String(canvas.height));
        svg.setAttribute('viewBox', layer.getAttribute('viewBox'));
        svg.setAttribute('preserveAspectRatio', 'none');
        for (const shape of layer.querySelectorAll('[data-utb-annot-state="committed"]')) {
          svg.appendChild(shape.cloneNode(true));
        }
        const source = new Blob([new XMLSerializer().serializeToString(svg)], { type: 'image/svg+xml;charset=utf-8' });
        const url = URL.createObjectURL(source);
        try {
          const overlay = new Image();
          overlay.src = url;
          await overlay.decode();
          context.drawImage(overlay, 0, 0);
        } finally {
          URL.revokeObjectURL(url);
        }
        return await new Promise((resolve, reject) => canvas.toBlob(
          (blob) => blob ? resolve(blob) : reject(new Error('无法生成标注截图')), 'image/png'));
      }

      async function captureAnnotationShot() {
        if (annotShotBusy) return;
        setAnnotShotNotice('');
        const target = annotShotTarget();
        if (!target.ok) {
          setAnnotShotNotice('截图失败：' + target.reason);
          return;
        }
        setAnnotShotBusy(true);
        const generation = captureGenerationRef.current;
        try {
          let bytes;
          if (blenderView) {
            bytes = await captureBlenderAnnotationShot();
          } else {
            // 先让「已接受」的文档追上最新笔画：截图取的是 Host 侧文档，pending 时不等待就会少一笔。
            if (annotDirtyRef.current || annotSyncRef.current.state === 'pending') {
              try { annotFlushPending(); } catch { /* best effort */ }
              await new Promise((resolve) => { window.setTimeout(resolve, 260); });
            }
            const scopeNow = scopeRef.current;
            const response = await fetch(HOST_BASE + '/screenshot', {
              method: 'POST',
              headers: Object.assign({ 'content-type': 'application/json' }, scopeHeaders(scopeNow)),
              credentials: 'same-origin',
              body: JSON.stringify({ includeAnnotations: true }),
            });
            const payload = await response.json().catch(() => null);
            if (!response.ok || !payload || payload.ok !== true || !payload.image) {
              throw new Error((payload && (payload.error || payload.reason)) || ('HTTP ' + response.status));
            }
            const binary = atob(payload.image);
            bytes = new Uint8Array(binary.length);
            for (let index = 0; index < binary.length; index += 1) bytes[index] = binary.charCodeAt(index);
          }
          if (generation !== captureGenerationRef.current) return;
          const stamp = new Date().toISOString().replace(/[:.]/g, '-');
          const file = new File([bytes], 'annotation-' + stamp + '.png', { type: 'image/png' });
          const drafts = target.conversation.createDrafts(target.sid, [file], false);
          const list = Array.isArray(drafts) ? drafts : [];
          const ids = list.map((draft) => draft && draft.id).filter(Boolean);
          if (!ids.length) throw new Error('附件没有被聊天框接受');
          const added = target.face.addAttachments(ids);
          if (!added) {
            // 回车发送中/命令执行中的聊天框会拒绝新附件：立刻释放，避免留下看不见的孤儿附件。
            for (const draft of list) {
              try { target.conversation.releaseDraftAttachment(draft.id); } catch { /* best effort */ }
            }
            throw new Error('聊天框正忙（发送中），稍后再试');
          }
          // 成功不弹任何提示：附件本身就出现在聊天框里，那一张缩略图就是结果；
          // 失败才在按钮旁给具体原因（静默失败才是真问题）。
          try { if (typeof target.face.focus === 'function') target.face.focus(); } catch { /* best effort */ }
        } catch (error) {
          setAnnotShotNotice('截图失败：' + String((error && error.message) || error));
        } finally {
          setAnnotShotBusy(false);
        }
      }

      function clearAnnotCanvas() {
        if (!annotRef.current.on) return;
        // The pointerdown of the button already cancelled a live edit; this covers keyboard activation.
        if (annotEditRef.current.active) cancelAnnotText();
        cancelAnnotDraft();
        resetAnnotErase();
        resetAnnotMarquee();
        annotMoveRef.current = { active: false, pointerId: -1, map: null, start: null, last: null, origin: null, changed: false };
        annotSelectionRef.current = new Set();
        annotShapesRef.current = [];
        annotContentSeqRef.current += 1;
        annotDirtyRef.current = true;
        setAnnotText(null);
        setAnnotVersion((value) => value + 1);
        // Explicit user clear is a content modification (release:false empty document), not a release.
        annotPublishNow();
      }

      /** 清除按钮的按下阶段：先取消编辑，压住随后的 blur 提交（防止文字“复活”）。 */
      function annotClearPointerDown() {
        cancelAnnotDraft();
        if (annotEditRef.current.active) cancelAnnotText();
      }

      function annotDraftNode(tag, attrs) {
        const node = document.createElementNS(SVG_NS, tag);
        for (const [key, value] of Object.entries(attrs || {})) node.setAttribute(key, String(value));
        node.setAttribute('pointer-events', 'none');
        return node;
      }

      /** Arrow geometry: head length min(3t, L), base width min(2t, L), same-colour filled triangle. */
      function annotArrowGeometry(start, end, width) {
        const dx = end.x - start.x;
        const dy = end.y - start.y;
        const length = Math.hypot(dx, dy);
        if (!(length > 0)) return null;
        const t = Math.max(1, Number(width) || 1);
        const headLength = Math.min(3 * t, length);
        const headWidth = Math.min(2 * t, length);
        const ux = dx / length;
        const uy = dy / length;
        const base = { x: end.x - ux * headLength, y: end.y - uy * headLength };
        const nx = -uy;
        const ny = ux;
        return {
          length,
          base,
          points: [
            end,
            { x: base.x + nx * (headWidth / 2), y: base.y + ny * (headWidth / 2) },
            { x: base.x - nx * (headWidth / 2), y: base.y - ny * (headWidth / 2) },
          ],
        };
      }

      function annotPointsText(points) {
        return (points || []).map((point) => `${Math.round(point.x * 100) / 100},${Math.round(point.y * 100) / 100}`).join(' ');
      }

      function clearAnnotDraftNode() {
        const draft = annotDraftRef.current;
        if (!draft) return;
        while (draft.firstChild) draft.removeChild(draft.firstChild);
      }

      function buildAnnotDraft(gesture) {
        const draft = annotDraftRef.current;
        if (!draft) return;
        clearAnnotDraftNode();
        const style = gesture.style;
        const fill = style.fill ? style.color : 'none';
        const stroke = style.stroke ? style.color : 'none';
        gesture.nodes = {};
        if (gesture.tool === 'circle') {
          gesture.nodes.circle = annotDraftNode('ellipse', {
            cx: gesture.start.x, cy: gesture.start.y, rx: 0, ry: 0,
            fill, stroke, 'stroke-width': style.width, 'stroke-linecap': 'round', 'stroke-linejoin': 'round',
          });
          draft.appendChild(gesture.nodes.circle);
        } else if (gesture.tool === 'rect') {
          gesture.nodes.rect = annotDraftNode('rect', {
            x: gesture.start.x, y: gesture.start.y, width: 0, height: 0,
            fill, stroke, 'stroke-width': style.width, 'stroke-linecap': 'round', 'stroke-linejoin': 'round',
          });
          draft.appendChild(gesture.nodes.rect);
        } else if (gesture.tool === 'line') {
          gesture.nodes.line = annotDraftNode('line', {
            x1: gesture.start.x, y1: gesture.start.y, x2: gesture.start.x, y2: gesture.start.y,
            fill: 'none', stroke: style.color, 'stroke-width': style.width, 'stroke-linecap': 'round',
          });
          draft.appendChild(gesture.nodes.line);
        } else if (gesture.tool === 'arrow') {
          gesture.nodes.line = annotDraftNode('line', {
            x1: gesture.start.x, y1: gesture.start.y, x2: gesture.start.x, y2: gesture.start.y,
            fill: 'none', stroke: style.color, 'stroke-width': style.width, 'stroke-linecap': 'round',
          });
          gesture.nodes.polygon = annotDraftNode('polygon', {
            points: annotPointsText([gesture.start, gesture.start, gesture.start]),
            fill: style.color, stroke: 'none',
          });
          draft.appendChild(gesture.nodes.line);
          draft.appendChild(gesture.nodes.polygon);
        } else if (gesture.tool === 'brush') {
          gesture.nodes.polyline = annotDraftNode('polyline', {
            points: annotPointsText(gesture.points),
            fill: 'none', stroke: style.color, 'stroke-width': style.width,
            'stroke-linecap': 'round', 'stroke-linejoin': 'round',
          });
          draft.appendChild(gesture.nodes.polyline);
        }
      }

      function renderAnnotDraft(gesture) {
        if (!gesture || !gesture.nodes) return;
        const start = gesture.start;
        const end = gesture.end || start;
        if (gesture.tool === 'circle' && gesture.nodes.circle) {
          // PS ellipse default: the press and the release are two bbox corners (any direction).
          gesture.nodes.circle.setAttribute('cx', String((start.x + end.x) / 2));
          gesture.nodes.circle.setAttribute('cy', String((start.y + end.y) / 2));
          gesture.nodes.circle.setAttribute('rx', String(Math.abs(end.x - start.x) / 2));
          gesture.nodes.circle.setAttribute('ry', String(Math.abs(end.y - start.y) / 2));
        } else if (gesture.tool === 'rect' && gesture.nodes.rect) {
          gesture.nodes.rect.setAttribute('x', String(Math.min(start.x, end.x)));
          gesture.nodes.rect.setAttribute('y', String(Math.min(start.y, end.y)));
          gesture.nodes.rect.setAttribute('width', String(Math.abs(end.x - start.x)));
          gesture.nodes.rect.setAttribute('height', String(Math.abs(end.y - start.y)));
        } else if (gesture.tool === 'line' && gesture.nodes.line) {
          gesture.nodes.line.setAttribute('x1', String(start.x));
          gesture.nodes.line.setAttribute('y1', String(start.y));
          gesture.nodes.line.setAttribute('x2', String(end.x));
          gesture.nodes.line.setAttribute('y2', String(end.y));
        } else if (gesture.tool === 'arrow' && gesture.nodes.line && gesture.nodes.polygon) {
          const geometry = annotArrowGeometry(start, end, gesture.style.width);
          if (geometry) {
            gesture.nodes.line.setAttribute('x1', String(start.x));
            gesture.nodes.line.setAttribute('y1', String(start.y));
            gesture.nodes.line.setAttribute('x2', String(geometry.base.x));
            gesture.nodes.line.setAttribute('y2', String(geometry.base.y));
            gesture.nodes.polygon.setAttribute('points', annotPointsText(geometry.points));
          }
        } else if (gesture.tool === 'brush' && gesture.nodes.polyline) {
          const points = gesture.points.concat([end]);
          gesture.nodes.polyline.setAttribute('points', annotPointsText(points));
        }
      }

      function scheduleAnnotRender(gesture) {
        if (annotRafRef.current) return;
        annotRafRef.current = window.requestAnimationFrame(() => {
          annotRafRef.current = 0;
          const current = annotGestureRef.current;
          if (current.active && current === gesture) renderAnnotDraft(current);
        });
      }

      function resetAnnotGesture() {
        annotGestureRef.current = {
          active: false, pointerId: -1, map: null, tool: '', style: null,
          start: null, end: null, points: [], trace: [], pathLen: 0,
          lastScreen: null, lastSampleScreen: null, lastPoint: null, nodes: null,
        };
      }

      function cancelAnnotDraft() {
        if (annotRafRef.current) {
          window.cancelAnimationFrame(annotRafRef.current);
          annotRafRef.current = 0;
        }
        const gesture = annotGestureRef.current;
        const svg = annotSvgRef.current;
        if (gesture.active && svg && gesture.pointerId >= 0) {
          try { svg.releasePointerCapture(gesture.pointerId); } catch { /* ignore */ }
        }
        resetAnnotGesture();
        clearAnnotDraftNode();
        setAnnotBusy(false);
        // A cancelled gesture may leave the panel clean: a newer Host revision can be adopted now.
        annotResumeAfterTransient();
      }

      /** Allocate a local id above both the local watermark and every imported `aN` (never reuse). */
      function annotAllocateId() {
        const used = new Set(annotShapesRef.current.map((item) => item.id));
        if (!Number.isSafeInteger(annotNextIdRef.current) || annotNextIdRef.current < 0) {
          annotNextIdRef.current = 0;
        }
        let id = '';
        let guard = 0;
        do {
          annotNextIdRef.current += 1;
          id = 'a' + annotNextIdRef.current;
          guard += 1;
          if (guard > 100000) break;
        } while (used.has(id));
        return id;
      }

      function pushAnnotShape(shape) {
        annotShapesRef.current = annotShapesRef.current.concat([
          Object.assign({ id: annotAllocateId() }, shape),
        ]);
        annotContentSeqRef.current += 1;
        annotDirtyRef.current = true;
        setAnnotVersion((value) => value + 1);
        // 提交/文字提交进入 150ms trailing 合并（§11.3）；失败只影响同步状态，不影响绘制。
        annotPublishSchedule();
      }

      /** Validate the committed gesture; null = below the minimum gesture (nothing is created). */
      function annotCommitFromGesture(gesture, point) {
        const start = gesture.start;
        const map = gesture.map;
        const style = gesture.style;
        const dxScreen = (point.x - start.x) * map.sx;
        const dyScreen = (point.y - start.y) * map.sy;
        if (gesture.tool === 'circle') {
          // Bbox minimum: both sides ≥2 screen px (a thin drag is not an object).
          if (Math.abs(dxScreen) < 2 || Math.abs(dyScreen) < 2) return null;
          return {
            type: 'circle',
            cx: (start.x + point.x) / 2,
            cy: (start.y + point.y) / 2,
            rx: Math.abs(point.x - start.x) / 2,
            ry: Math.abs(point.y - start.y) / 2,
            color: style.color, strokeWidth: style.width, fill: Boolean(style.fill), stroke: Boolean(style.stroke),
          };
        }
        if (gesture.tool === 'rect') {
          if (Math.abs(dxScreen) < 2 || Math.abs(dyScreen) < 2) return null;
          return {
            type: 'rect', x: Math.min(start.x, point.x), y: Math.min(start.y, point.y),
            w: Math.abs(point.x - start.x), h: Math.abs(point.y - start.y),
            color: style.color, strokeWidth: style.width, fill: Boolean(style.fill), stroke: Boolean(style.stroke),
          };
        }
        if (gesture.tool === 'line' || gesture.tool === 'arrow') {
          if (Math.hypot(dxScreen, dyScreen) < 2) return null;
          return { type: gesture.tool, x1: start.x, y1: start.y, x2: point.x, y2: point.y, color: style.color, strokeWidth: style.width, fill: false, stroke: true };
        }
        if (gesture.tool === 'brush') {
          // A tiny closed loop can accumulate ≥2 screen px without ever reaching the 2 px sampling
          // threshold between samples; fall back to the raw trace in that case only.
          let points = gesture.points.slice();
          if (points.length < 2 && gesture.trace.length >= 2) points = gesture.trace.slice();
          const last = points[points.length - 1];
          if (!last || Math.abs(last.x - point.x) > 1e-6 || Math.abs(last.y - point.y) > 1e-6) points.push(point);
          // Cumulative *screen* path length (a closed loop returning to the first point is valid).
          if (gesture.pathLen < 2 || points.length < 2) return null;
          return { type: 'brush', points, color: style.color, strokeWidth: style.width, fill: false, stroke: true };
        }
        return null;
      }

      function onAnnotPointerDown(event) {
        if (!annotRef.current.on || event.button !== 0) return;
        const map = annotMapForEnv();
        if (!map || !annotInside(map, event.clientX, event.clientY)) return; // letterbox: no stroke
        event.preventDefault();
        event.stopPropagation();
        const svg = annotSvgRef.current;
        if (svg) { try { svg.focus({ preventScroll: true }); } catch { /* ignore */ } }
        const point = annotToCanvas(map, event.clientX, event.clientY);
        if (annotRef.current.tool === 'text') {
          openAnnotText(map, point);
          return;
        }
        if (annotRef.current.tool === 'eraser') {
          // 橡皮擦不产生图形、不走最小画图手势：按下即擦、拖动连续擦（§11.4）。
          cancelAnnotDraft();
          startAnnotErase(map, event, point);
          return;
        }
        if (annotRef.current.tool === 'select') {
          cancelAnnotDraft();
          const hit = annotTopmostAt(point, map);
          const mode = annotSelectionMode(event);
          if (!hit) {
            if (mode === 'replace' && annotSelectionContains(point)) annotStartMove(map, event, point);
            else startAnnotMarquee(map, event, point); // empty-space drag works with either tool
            return;
          }
          if (mode === 'subtract' || mode === 'intersect') {
            annotApplySelection([hit.id], mode, annotSelectionRef.current, false);
            return;
          }
          if (mode !== 'replace' && annotSelectionRef.current.has(hit.id)) {
            // Shift-click toggles on release, but Shift-drag keeps the group and locks its axis.
            annotStartMove(map, event, point);
            annotMoveRef.current.toggleOnClick = hit.id;
            return;
          }
          if (!annotSelectionRef.current.has(hit.id)) annotApplySelection([hit.id], mode, annotSelectionRef.current, false);
          annotStartMove(map, event, point);
          return;
        }
        if (annotRef.current.tool === 'marquee') {
          if (annotSelectionMode(event) === 'replace' && annotSelectionContains(point)) {
            cancelAnnotDraft();
            annotStartMove(map, event, point);
            return;
          }
          startAnnotMarquee(map, event, point);
          return;
        }
        cancelAnnotDraft();
        setAnnotBusy(true);
        const style = annotSnapshot();
        const gesture = {
          active: true, pointerId: event.pointerId, map, tool: style.tool, style,
          start: point, end: point, points: [point], trace: [point], pathLen: 0,
          lastScreen: { x: event.clientX, y: event.clientY },
          lastSampleScreen: { x: event.clientX, y: event.clientY },
          lastPoint: point, nodes: null,
        };
        annotGestureRef.current = gesture;
        annotMapSigRef.current = annotMapSignature(map);
        buildAnnotDraft(gesture);
        renderAnnotDraft(gesture);
        try { if (svg) svg.setPointerCapture(event.pointerId); } catch { /* ignore */ }
      }

      function annotSetHoverCursor(mode) {
        const next = ['move', 'grabbing', 'crosshair'].includes(mode) ? mode : 'default';
        annotHoverRef.current = next;
        const svg = annotSvgRef.current;
        if (svg) svg.style.cursor = next;
      }

      /** Select/marquee hover: 'move' over a shape or inside the selection box, else the tool base. */
      function annotUpdateHoverCursor(event) {
        const base = annotRef.current.tool === 'marquee' ? 'crosshair' : 'default';
        const map = annotMapForEnv();
        if (!map || !annotInside(map, event.clientX, event.clientY)) {
          annotSetHoverCursor(base);
          return;
        }
        const point = annotToCanvas(map, event.clientX, event.clientY);
        const modified = annotSelectionMode(event) !== 'replace';
        const movable = annotRef.current.tool === 'select'
          ? !event.altKey && (annotTopmostAt(point, map) || (!modified && annotSelectionContains(point)))
          : !modified && annotSelectionContains(point);
        annotSetHoverCursor(movable ? 'move' : base);
      }

      function onAnnotPointerMove(event) {
        if (annotRef.current.on && annotEraseRef.current.active
          && annotEraseRef.current.pointerId === event.pointerId) {
          event.preventDefault();
          moveAnnotErase(event);
          return;
        }
        if (annotMoveRef.current.active && annotMoveRef.current.pointerId === event.pointerId) {
          if (!annotRef.current.on) return;
          event.preventDefault();
          moveAnnotSelection(event);
          return;
        }
        if (annotMarqueeRef.current.active && annotMarqueeRef.current.pointerId === event.pointerId) {
          if (!annotRef.current.on) return;
          event.preventDefault();
          moveAnnotMarquee(event);
          return;
        }
        if (annotRef.current.on && (annotRef.current.tool === 'select' || annotRef.current.tool === 'marquee')
          && !annotGestureRef.current.active) {
          annotUpdateHoverCursor(event);
          return;
        }
        const gesture = annotGestureRef.current;
        if (!annotRef.current.on || !gesture.active || gesture.pointerId !== event.pointerId) return;
        event.preventDefault();
        const point = annotToCanvas(gesture.map, event.clientX, event.clientY);
        if (gesture.tool === 'brush') {
          const step = Math.hypot(event.clientX - gesture.lastScreen.x, event.clientY - gesture.lastScreen.y);
          gesture.pathLen += step;
          gesture.lastScreen = { x: event.clientX, y: event.clientY };
          gesture.trace.push(point);
          const sinceSample = Math.hypot(event.clientX - gesture.lastSampleScreen.x, event.clientY - gesture.lastSampleScreen.y);
          // ≥2 screen CSS px between sampled points; the final point is appended on pointerup.
          if (sinceSample >= 2) {
            gesture.points.push(point);
            gesture.lastSampleScreen = { x: event.clientX, y: event.clientY };
            gesture.lastPoint = point;
          }
        }
        gesture.end = point;
        scheduleAnnotRender(gesture);
      }

      function onAnnotPointerUp(event) {
        if (annotEraseRef.current.active && annotEraseRef.current.pointerId === event.pointerId) {
          event.preventDefault();
          finishAnnotErase();
          return;
        }
        if (annotMoveRef.current.active && annotMoveRef.current.pointerId === event.pointerId) {
          event.preventDefault();
          moveAnnotSelection(event);
          finishAnnotMove();
          return;
        }
        if (annotMarqueeRef.current.active && annotMarqueeRef.current.pointerId === event.pointerId) {
          event.preventDefault();
          moveAnnotMarquee(event);
          finishAnnotMarquee();
          return;
        }
        const gesture = annotGestureRef.current;
        if (!annotRef.current.on || !gesture.active || gesture.pointerId !== event.pointerId) return;
        event.preventDefault();
        const point = annotToCanvas(gesture.map, event.clientX, event.clientY);
        const shape = annotCommitFromGesture(gesture, point);
        const svg = annotSvgRef.current;
        try { if (svg) svg.releasePointerCapture(event.pointerId); } catch { /* ignore */ }
        if (annotRafRef.current) {
          window.cancelAnimationFrame(annotRafRef.current);
          annotRafRef.current = 0;
        }
        resetAnnotGesture();
        clearAnnotDraftNode();
        setAnnotBusy(false);
        if (shape) pushAnnotShape(shape);
      }

      function onAnnotPointerCancel(event) {
        if (annotEraseRef.current.active
          && (event === undefined || event.pointerId === undefined || annotEraseRef.current.pointerId === event.pointerId)) {
          // 擦掉的对象不因 pointercancel/Esc 回滚，结束时照常 flush（§11.4）。
          finishAnnotErase();
          return;
        }
        if (annotMoveRef.current.active
          && (event === undefined || event.pointerId === undefined || annotMoveRef.current.pointerId === event.pointerId)) {
          cancelAnnotMove();
          return;
        }
        if (annotMarqueeRef.current.active
          && (event === undefined || event.pointerId === undefined || annotMarqueeRef.current.pointerId === event.pointerId)) {
          cancelAnnotMarquee();
          return;
        }
        const gesture = annotGestureRef.current;
        if (!gesture.active) return;
        if (event && event.pointerId !== undefined && gesture.pointerId !== event.pointerId) return;
        cancelAnnotDraft();
      }

      function openAnnotText(map, point) {
        cancelAnnotDraft();
        if (annotEditRef.current.active) commitAnnotText();
        const style = annotSnapshot();
        const screen = annotScreenPoint(map, point);
        annotEditRef.current = {
          active: true, cancel: false, map, x: point.x, y: point.y, style,
        };
        annotMapSigRef.current = annotMapSignature(map);
        annotEditSeqRef.current += 1;
        setAnnotText({
          id: annotEditSeqRef.current,
          left: screen.x - map.boxRect.left,
          top: screen.y - map.boxRect.top,
          fontSize: 20 * map.sy,
          color: style.color,
        });
        window.requestAnimationFrame(() => {
          const input = annotInputRef.current;
          if (input) { try { input.focus(); } catch { /* ignore */ } }
        });
      }

      /** Commit/cancel one text edit. Cancellation is marked *before* the input unmounts, so the
       * subsequent blur cannot submit twice (docs/viewport-control.md). */
      function finishAnnotText(commit) {
        const edit = annotEditRef.current;
        if (!edit.active) return;
        const input = annotInputRef.current;
        const value = input ? String(input.value || '') : '';
        edit.active = false;
        if (!commit) edit.cancel = true;
        setAnnotText(null);
        if (!commit || edit.cancel) {
          if (!commit) annotResumeAfterTransient();
          return;
        }
        const text = value.slice(0, 200);
        if (!text.trim()) return;
        pushAnnotShape({
          type: 'text', x: edit.x, y: edit.y, text,
          color: edit.style.color, strokeWidth: edit.style.width, fill: true, stroke: false,
        });
      }

      function commitAnnotText() {
        finishAnnotText(true);
      }

      function cancelAnnotText() {
        const edit = annotEditRef.current;
        if (edit.active) edit.cancel = true;
        finishAnnotText(false);
      }

      /** Cancel the uncommitted draft/edit only; committed shapes stay (mode exit keeps them). */
      function annotCancelTransient() {
        cancelAnnotDraft();
        cancelAnnotMove();
        cancelAnnotMarquee();
        resetAnnotErase();
        setAnnotBusy(false);
        const edit = annotEditRef.current;
        if (edit.active) {
          edit.cancel = true;
          edit.active = false;
          setAnnotText(null);
        }
        // A cancelled gesture/edit may make the panel clean again: adopt a pending Host revision
        // and/or retry a remembered dirty document once the channel is available (§12.3).
        annotResumeAfterTransient();
      }

      function enterAnnotMode() {
        // 用户 2026-11-03 第 2 条：尺寸调整模式内禁止进入标注（程序化/键盘同一道闸）。
        if (sizingRef.current) return;
        // 选元素模式与标注互斥：同一道闸，程序化/键盘入口也不得越过。
        if (pickRef.current.on) return;
        // 无视图环境没有页面，但仍有可画的空白画布：不要求视口同步 / 画布模式。
        if (annotRef.current.on) return;
        if (blenderView && blenderStatus.phase !== 'ready') return;
        if (envHasView && (!viewSync || !canvasOn)) return;
        // Finish any page drag (release its button) *before* the mode gate is raised.
        if (dragRef.current.active) releaseFrameDrag();
        // Drop unsent pan/zoom intent: entering the mode must not publish a stale view.
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
        cancelDraft();
        annotRef.current.on = true;
        setAnnotOn(true);
        window.requestAnimationFrame(() => {
          const svg = annotSvgRef.current;
          if (svg) { try { svg.focus({ preventScroll: true }); } catch { /* ignore */ } }
        });
      }

      function exitAnnotMode() {
        if (!annotRef.current.on) return;
        // Closing the panel exits the mode but keeps every committed annotation visible (contract §5).
        annotCancelTransient();
        annotSelectionRef.current = new Set();
        setAnnotText(null);
        resetAnnotErase();
        setAnnotBusy(false);
        annotRef.current.on = false;
        setAnnotOn(false);
        // v2：模式退出立即 flush（§11.3）。
        annotFlushPending();
      }

      function toggleAnnotMode() {
        if (annotRef.current.on) exitAnnotMode();
        else enterAnnotMode();
      }

      /* ---- 选元素发送到聊天框：模式 / 悬浮命中 / 加入聊天框 ------------------------------- */
