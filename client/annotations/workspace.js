      function annotSnapshot() {
        const current = annotRef.current;
        return { tool: current.tool, color: current.color, width: current.width, fill: current.fill, stroke: current.stroke };
      }

      function annotIsClosedTool(tool) {
        return tool === 'circle' || tool === 'rect';
      }

      /**
       * Current painted mapping of the annotation layer. The SVG must cover the *untranslated*
       * painted rect (the <img> itself may be translated by canvas compositing), so this never reads
       * `frameShift`/`seedClip`.
       */
      /**
       * 目标环境的标注坐标映射注册表。环境实现（view 模块）接入时把 provider 注册到这里：
       *   ENV_ANNOT_MAP.android = () => androidMap();
       * 壳只负责解析与兜底，不再按环境名写死坐标推导。未注册 → 公共默认：空白视图窗 1:1 画布。
       */
      const ENV_ANNOT_MAP = {
        web: () => (canvasOn && shot ? annotMap() : null),
        'three-d': annotBlenderMap,
      };

      function resolveAnnotMap() {
        const provider = ENV_ANNOT_MAP[env];
        if (typeof provider === 'function') return provider();
        return annotBlankMap();
      }

      function annotMapForEnv() {
        return resolveAnnotMap();
      }

      function annotMap() {
        const img = frameImgRef.current;
        const box = frameBoxRef.current;
        if (!img || !box) return null;
        const boxRect = box.getBoundingClientRect();
        const painted = paintedRect(boxRect, img.naturalWidth, img.naturalHeight);
        if (!painted) return null;
        const canvas = canvasPosition();
        const size = acceptedViewSize();
        if (!canvas || !(size.w > 0) || !(size.h > 0)) return null;
        const sx = painted.width / size.w;
        const sy = painted.height / size.h;
        if (!(sx > 0) || !(sy > 0)) return null;
        return { painted, boxRect, cx: canvas.x, cy: canvas.y, w: size.w, h: size.h, sx, sy };
      }

      function annotMapSignature(map) {
        if (!map) return '';
        const round = (value) => Math.round(Number(value) * 100) / 100;
        return [map.painted.left, map.painted.top, map.painted.width, map.painted.height, map.cx, map.cy, map.w, map.h]
          .map(round).join('|');
      }

      /** Pointer → canvas CSS px through one frozen mapping, clamped to the captured view rect. */
      function annotToCanvas(map, clientX, clientY) {
        return {
          x: clampNumber(map.cx + (clientX - map.painted.left) / map.sx, map.cx, map.cx + map.w),
          y: clampNumber(map.cy + (clientY - map.painted.top) / map.sy, map.cy, map.cy + map.h),
        };
      }

      /** Half-open painted rect: the letterbox is not a drawable surface. */
      function annotInside(map, clientX, clientY) {
        return clientX >= map.painted.left && clientX < map.painted.left + map.painted.width
          && clientY >= map.painted.top && clientY < map.painted.top + map.painted.height;
      }

      function annotScreenPoint(map, point) {
        return {
          x: map.painted.left + (point.x - map.cx) * map.sx,
          y: map.painted.top + (point.y - map.cy) * map.sy,
        };
      }

      /* ---- v3 工作区文档：水合 / 保留队列 / 发布者身份（docs/viewport-control.md）------------ */

      function annotSurfaceName() {
        return props && typeof props.useTabInfo === 'function' ? 'sidebar' : 'main';
      }

      function annotUiNow() {
        const accepted = remoteRef.current;
        return accepted && accepted.ui && accepted.ui.version === 1 ? accepted.ui : null;
      }

      /** Accepted Host annotation context (`ui.annotationContext`); null on an old Host. */
      function annotContextNow() {
        if (blenderView) return null;
        const ui = annotUiNow();
        const context = ui && ui.annotationContext;
        return context && typeof context === 'object' ? context : null;
      }

      /** D = (authenticated scope.id, runtimeId, documentKey, pageGeneration, documentEpoch). */
      function annotDOf(ui) {
        const context = ui && ui.annotationContext;
        const scopeId = ui && ui.scope && ui.scope.id ? String(ui.scope.id) : '';
        if (!context || typeof context !== 'object' || !scopeId) return null;
        if (!context.runtimeId || !context.documentKey) return null;
        return {
          scopeId,
          runtimeId: String(context.runtimeId),
          documentKey: String(context.documentKey),
          pageGeneration: context.pageGeneration === undefined ? null : context.pageGeneration,
          documentEpoch: context.documentEpoch === undefined ? null : context.documentEpoch,
        };
      }

      function annotDKey(d) {
        return d ? [d.scopeId, d.runtimeId, d.documentKey, d.pageGeneration, d.documentEpoch].join('|') : '';
      }

      function annotContextMatches(a, b) {
        if (!a || !b) return false;
        return ['runtimeId', 'documentKey', 'pageGeneration', 'documentEpoch', 'addressDigest']
          .every((name) => String(a[name] === undefined ? '' : a[name]) === String(b[name] === undefined ? '' : b[name]));
      }

      /** The accepted view as the panel currently sees it (a snapshot, not the live truth). */
      function annotViewSnapshot() {
        const view = viewRef.current;
        const canvas = canvasPosition();
        const size = acceptedViewSize();
        const scroll = observedScroll();
        const number = (value, fallback) => (Number.isFinite(Number(value)) ? Number(value) : fallback);
        const round2 = (value) => Math.round(value * 100) / 100;
        const canvasX = canvas ? number(canvas.x, 0) : (view ? number(view.canvasX, 0) : 0);
        const canvasY = canvas ? number(canvas.y, 0) : (view ? number(view.canvasY, 0) : 0);
        const scale = Math.min(2, Math.max(0.1, view ? number(view.scale, 1) : 1));
        const epoch = annotEpochRef.current;
        return {
          canvasX,
          canvasY,
          x: round2(scroll.x),
          y: round2(scroll.y),
          width: Math.round(Math.min(4096, Math.max(200, size.w))),
          height: Math.round(Math.min(4096, Math.max(200, size.h))),
          scale,
          contentWidth: canvas && Number.isFinite(Number(canvas.contentWidth)) ? Number(canvas.contentWidth) : null,
          contentHeight: canvas && Number.isFinite(Number(canvas.contentHeight)) ? Number(canvas.contentHeight) : null,
          viewRevision: view ? Math.max(0, Math.round(number(view.revision, 0))) : 0,
          frameEpoch: epoch === null || epoch === undefined || !Number.isFinite(Number(epoch))
            ? null : Math.max(0, Math.round(Number(epoch))),
        };
      }

      function annotHexColor(value) {
        const text = String(value === undefined || value === null ? '' : value).trim().toLowerCase();
        return /^#[0-9a-f]{6}$/.test(text) ? text : ANNOT_DEFAULT.color;
      }

      /** Local shape → Host wire shape (§11.2): exactly the whitelisted fields, no extras. */
      function annotWireShape(shape) {
        const color = annotHexColor(shape.color);
        const strokeWidth = Math.max(1, Math.min(20, Math.round(Number(shape.strokeWidth) || 1)));
        const common = {
          id: shape.id,
          type: shape.type,
          color,
          strokeWidth,
          fill: Boolean(shape.fill),
          stroke: Boolean(shape.stroke),
        };
        if (shape.type === 'rect') {
          return Object.assign(common, { x: shape.x, y: shape.y, width: shape.w, height: shape.h });
        }
        if (shape.type === 'circle') {
          return Object.assign(common, { cx: shape.cx, cy: shape.cy, rx: shape.rx, ry: shape.ry });
        }
        if (shape.type === 'line') {
          return Object.assign(common, { x1: shape.x1, y1: shape.y1, x2: shape.x2, y2: shape.y2 });
        }
        if (shape.type === 'arrow') {
          // The Host recomputes the head; sending the same deterministic values keeps both ends equal.
          const length = Math.hypot(shape.x2 - shape.x1, shape.y2 - shape.y1);
          return Object.assign(common, {
            x1: shape.x1, y1: shape.y1, x2: shape.x2, y2: shape.y2,
            head: { length: Math.min(3 * strokeWidth, length), width: Math.min(2 * strokeWidth, length) },
          });
        }
        if (shape.type === 'brush') {
          return Object.assign(common, { points: (shape.points || []).map((point) => [point.x, point.y]) });
        }
        if (shape.type === 'text') {
          return Object.assign(common, { x: shape.x, y: shape.y, fontSize: 20, text: String(shape.text || '') });
        }
        return null;
      }

      /**
       * Host wire shape → local shape (§12.2): deep copy, keep order/id/style, rect `width/height`
       * become local `w/h`, brush `[[x,y]]` becomes `{x,y}`; geometry is already canvas CSS px and
       * is never re-scaled. Invalid/foreign entries are dropped instead of guessed.
       */
      function annotWireToLocal(wire) {
        if (!wire || typeof wire !== 'object') return null;
        const type = wire.type;
        if (!['circle', 'rect', 'line', 'arrow', 'brush', 'text'].includes(type)) return null;
        if (typeof wire.id !== 'string' || !ANNOT_ID_PATTERN.test(wire.id)) return null;
        const rawWidth = Number(wire.strokeWidth);
        if (!Number.isFinite(rawWidth)) return null;
        const common = {
          id: wire.id,
          type,
          color: annotHexColor(wire.color),
          strokeWidth: Math.max(1, Math.min(20, Math.round(rawWidth))),
          fill: wire.fill === true,
          stroke: wire.stroke === true,
        };
        const num = (value) => (Number.isFinite(Number(value)) ? Number(value) : null);
        if (type === 'rect') {
          const x = num(wire.x);
          const y = num(wire.y);
          const w = num(wire.width);
          const h = num(wire.height);
          if (x === null || y === null || !(w > 0) || !(h > 0)) return null;
          return Object.assign(common, { x, y, w, h });
        }
        if (type === 'circle') {
          const cx = num(wire.cx);
          const cy = num(wire.cy);
          const rx = num(wire.rx);
          const ry = num(wire.ry);
          if (cx === null || cy === null || !(rx > 0) || !(ry > 0)) return null;
          return Object.assign(common, { cx, cy, rx, ry });
        }
        if (type === 'line' || type === 'arrow') {
          const x1 = num(wire.x1);
          const y1 = num(wire.y1);
          const x2 = num(wire.x2);
          const y2 = num(wire.y2);
          if (x1 === null || y1 === null || x2 === null || y2 === null) return null;
          return Object.assign(common, { x1, y1, x2, y2, fill: false, stroke: true });
        }
        if (type === 'brush') {
          const points = Array.isArray(wire.points)
            ? wire.points
              .filter((pair) => Array.isArray(pair) && pair.length === 2
                && Number.isFinite(Number(pair[0])) && Number.isFinite(Number(pair[1])))
              .map((pair) => ({ x: Number(pair[0]), y: Number(pair[1]) }))
            : [];
          if (points.length < 2) return null;
          return Object.assign(common, { points, fill: false, stroke: true });
        }
        const x = num(wire.x);
        const y = num(wire.y);
        if (x === null || y === null || typeof wire.text !== 'string') return null;
        return Object.assign(common, { x, y, text: wire.text, fill: true, stroke: false });
      }

      /** Replace the visible committed set with an imported Host/retained set (ids stay unique). */
      function annotApplyImported(wireShapes) {
        const imported = [];
        let maxId = 0;
        const previousWatermark = annotNextIdRef.current;
        for (const wire of Array.isArray(wireShapes) ? wireShapes : []) {
          const local = annotWireToLocal(wire);
          if (!local) continue;
          imported.push(local);
          const match = ANNOT_ID_PATTERN.exec(local.id);
          if (match) maxId = Math.max(maxId, Number(match[1]));
        }
        annotShapesRef.current = imported;
        annotPruneSelection();
        const safeWatermark = Number.isSafeInteger(previousWatermark) && previousWatermark >= 0 ? previousWatermark : 0;
        const safeMaxId = Number.isSafeInteger(maxId) && maxId >= 0 ? maxId : 0;
        annotNextIdRef.current = Math.max(safeWatermark, safeMaxId);
        setAnnotVersion((value) => value + 1);
      }

      /**
       * Local committed shapes → the normalized document plus the client-side truncation, using the
       * same deterministic rules as the Host (§11.2): keep the newest 128 shapes, downsample brushes
       * to 512 points preserving first/last, drop the oldest whole shapes for the point/byte budget.
       */
      function annotNormalize() {
        const truncation = { droppedShapes: 0, droppedPoints: 0, shortenedTextCodeUnits: 0 };
        let shapes = [];
        for (const local of annotShapesRef.current) {
          let working = local;
          if (local.type === 'text') {
            const text = String(local.text === undefined || local.text === null ? '' : local.text);
            let clipped = text.length > ANNOT_LIMITS.textChars ? text.slice(0, ANNOT_LIMITS.textChars) : text;
            // Never split a surrogate pair at the cap.
            if (/[\uD800-\uDBFF]$/.test(clipped)) clipped = clipped.slice(0, -1);
            if (clipped !== text) {
              truncation.shortenedTextCodeUnits += text.length - clipped.length;
              working = Object.assign({}, local, { text: clipped });
            }
          }
          const wire = annotWireShape(working);
          if (wire) shapes.push(wire);
        }
        if (shapes.length > ANNOT_LIMITS.shapes) {
          truncation.droppedShapes += shapes.length - ANNOT_LIMITS.shapes;
          shapes = shapes.slice(shapes.length - ANNOT_LIMITS.shapes);
        }
        shapes = shapes.map((shape) => {
          if (shape.type !== 'brush' || shape.points.length <= ANNOT_LIMITS.brushPoints) return shape;
          const count = shape.points.length;
          const points = [];
          for (let index = 0; index < ANNOT_LIMITS.brushPoints; index += 1) {
            points.push(shape.points[Math.round((index * (count - 1)) / (ANNOT_LIMITS.brushPoints - 1))]);
          }
          truncation.droppedPoints += count - points.length;
          return Object.assign({}, shape, { points });
        });
        const pointsOf = (list) => list.reduce((total, shape) => total + (shape.type === 'brush' ? shape.points.length : 0), 0);
        const encoder = typeof TextEncoder === 'function' ? new TextEncoder() : null;
        const bytesOf = (list) => {
          try {
            const text = JSON.stringify({ version: 1, shapes: list, truncation });
            return encoder ? encoder.encode(text).length : text.length;
          } catch { return 0; }
        };
        let guard = 0;
        while (shapes.length > 0 && (pointsOf(shapes) > ANNOT_LIMITS.documentPoints || bytesOf(shapes) > ANNOT_LIMITS.bytes)) {
          shapes.shift();
          truncation.droppedShapes += 1;
          guard += 1;
          if (guard > 200) break;
        }
        return { shapes, truncation };
      }

      function annotSetSyncState(state) {
        annotSyncRef.current.state = state;
        const revision = annotShownRevisionRef.current;
        setAnnotSync((current) => (current.state === state && current.revision === revision
          ? current : { state, revision }));
      }

      /** Stale metadata is read-time only: a change must re-render the hint but never move revisions. */
      function annotSetStale(stale, reason) {
        const next = { stale: stale === true, staleReason: reason || null };
        const previous = annotStaleRef.current;
        if (previous.stale === next.stale && previous.staleReason === next.staleReason) return;
        annotStaleRef.current = next;
        setAnnotStaleState(next);
      }

      /** ACK / 409 / failure events from the module queue, guarded by mount generation + scope + D. */
      function annotPublisherEvent(event) {
        const snapshot = event && event.snapshot;
        if (!snapshot) return;
        if (snapshot.mountGeneration !== annotMountGenerationRef.current) return;
        if (snapshot.scopeEpoch !== scopeEpochRef.current) return;
        const gate = annotGateRef.current;
        if (!gate.open || snapshot.dKey !== gate.key) return;
        if (event.type === 'ack') {
          const accepted = event.annotations;
          const revision = accepted && Number.isSafeInteger(Number(accepted.revision))
            ? Math.max(0, Number(accepted.revision)) : null;
          if (accepted && revision !== null) {
            gate.revision = Math.max(gate.revision, revision);
            annotSetStale(accepted.stale, accepted.staleReason);
          }
          if (snapshot.contentSeq === annotContentSeqRef.current) {
            // The final ACK's normalized document (including Host truncation) is the visible truth.
            if (accepted && Array.isArray(accepted.shapes)) {
              // An ACK for the previous edit must not replace the geometry under a held pointer.
              // Reconcile Host normalization/truncation when this move finishes or is cancelled.
              if (annotMoveRef.current.active) annotMoveRef.current.acceptedShapes = accepted.shapes;
              else annotApplyImported(accepted.shapes);
              annotDirtyRef.current = false;
            }
            if (revision !== null) annotShownRevisionRef.current = Math.max(annotShownRevisionRef.current, revision);
            annotSetSyncState('synced');
            annotMaybeAdoptCandidate();
          } else {
            annotSetSyncState('pending');
          }
          return;
        }
        if (event.type === 'error') {
          annotSetSyncState(event.final ? 'error' : 'pending');
          return;
        }
        if (event.type === 'stale') {
          // 409: this document's local content is stale; drop it and let the next accepted state
          // hydrate the rotated key. Another workspace's publisher/document is never touched.
          annotDropLocalView({ exit: false, discard: true });
        }
      }

      function annotSubscribePublisher(entry, key) {
        if (annotPublisherRef.current === entry && annotUnsubRef.current && annotGateRef.current.key === key) return;
        annotUnsubscribePublisher();
        annotPublisherRef.current = entry;
        annotUnsubRef.current = annotPublisherSubscribe(entry, annotPublisherEvent);
      }

      function annotUnsubscribePublisher() {
        if (annotUnsubRef.current) annotUnsubRef.current();
        annotUnsubRef.current = null;
      }

      /** The current publishing identity; null until the new scope's first trusted state opens the gate. */
      function annotIdentityNow(options) {
        if (blenderView) return null;
        const anyEpoch = Boolean(options && options.anyEpoch);
        const gate = annotGateRef.current;
        if (!gate.open || !gate.key) return null;
        if (!anyEpoch && gate.epoch !== scopeEpochRef.current) return null;
        // The currently accepted snapshot must still prove the same document/context (a vanished
        // `ui.annotationContext` or a rotated token must stop publishing immediately).
        const currentD = annotDOf(annotUiNow());
        if (!currentD || annotDKey(currentD) !== gate.key) return null;
        const entry = annotPublisherRef.current;
        if (!entry) return null;
        return {
          entry,
          dKey: gate.key,
          d: gate.d,
          context: Object.assign({}, gate.context),
          scope: gate.scope,
          // Cross-generation retains (scope change/unmount) must not read the new scope's view.
          view: anyEpoch ? (gate.view || annotViewSnapshot()) : annotViewSnapshot(),
        };
      }

      function annotBuildSnapshot(identity, normalized) {
        const entry = identity.entry;
        return {
          entryKey: entry.key,
          panelId: entry.panelId,
          surface: entry.surface,
          clientRevision: annotPublisherAllocate(entry),
          context: Object.assign({}, identity.context),
          scope: identity.scope,
          view: identity.view || annotViewSnapshot(),
          shapes: normalized.shapes,
          truncation: normalized.truncation,
          release: false,
          dKey: identity.dKey,
          contentSeq: annotContentSeqRef.current,
          mountGeneration: annotMountGenerationRef.current,
          scopeEpoch: scopeEpochRef.current,
        };
      }

      /** 150ms trailing merge for commit/文字提交/每次擦除（§11.3）. */
      function annotPublishSchedule() {
        if (!readyRef.current || !annotDirtyRef.current) return;
        const identity = annotIdentityNow();
        if (!identity) return;
        const store = annotSyncRef.current;
        if (store.timer) window.clearTimeout(store.timer);
        store.timer = window.setTimeout(() => {
          store.timer = 0;
          annotPublishNow();
        }, ANNOT_PUBLISH_DEBOUNCE_MS);
        annotSetSyncState('pending');
      }

      /** Freeze identity + normalized shapes and enqueue as the newest snapshot (at most 1 waiting). */
      function annotPublishNow() {
        // An older edit's debounce may fire during a new move. Only publish committed geometry.
        if (annotMoveRef.current.active) return null;
        const identity = annotIdentityNow();
        if (!identity) return null;
        const normalized = annotNormalize();
        const snapshot = annotBuildSnapshot(identity, normalized);
        annotPublisherQueue(identity.entry, snapshot);
        annotSetSyncState('pending');
        return snapshot;
      }

      /** Exit/flush: only genuinely dirty content is sent; a clean panel performs zero POSTs (§12.1). */
      function annotFlushPending() {
        const store = annotSyncRef.current;
        if (store.timer) {
          window.clearTimeout(store.timer);
          store.timer = 0;
        }
        if (annotDirtyRef.current) {
          annotPublishNow();
          return;
        }
        const entry = annotPublisherRef.current;
        if (entry) annotPublisherDrain(entry);
      }

      /**
       * Hand unconfirmed committed content to the module queue under the *old* frozen identity.
       * `flush` publishes it now (scope change / unmount); without `flush` it is only remembered
       * (capability temporarily unavailable). It is never converted into an empty document.
       */
      function annotRetainDirty(flush) {
        if (blenderView) return;
        // Retained content is committed content; a scope/runtime change cancels a held move first.
        cancelAnnotMove();
        if (!annotDirtyRef.current) return;
        const normalized = annotNormalize();
        const identity = annotIdentityNow({ anyEpoch: true });
        if (!identity) {
          const entry = annotPublisherRef.current;
          if (entry) {
            annotPublisherRemember(entry, {
              shapes: normalized.shapes,
              truncation: normalized.truncation,
              contentSeq: annotContentSeqRef.current,
              dKey: annotGateRef.current.key,
            });
          }
          annotDirtyRef.current = false;
          return;
        }
        if (flush) annotPublisherQueue(identity.entry, annotBuildSnapshot(identity, normalized));
        else {
          annotPublisherRemember(identity.entry, {
            shapes: normalized.shapes,
            truncation: normalized.truncation,
            contentSeq: annotContentSeqRef.current,
            dKey: identity.dKey,
          });
        }
        annotDirtyRef.current = false;
      }

      /**
       * Retract this panel's local view only: no release, no empty document, no POST. The gate is
       * closed so old shapes are neither rendered nor published until a trusted state re-opens it.
       */
      function annotDropLocalView(options) {
        const exit = Boolean(options && options.exit);
        const discard = Boolean(options && options.discard);
        annotCancelTransient();
        setAnnotText(null);
        resetAnnotErase();
        setAnnotBusy(false);
        annotShapesRef.current = [];
        annotSelectionRef.current = new Set();
        annotCandidateRef.current = null;
        setAnnotVersion((value) => value + 1);
        annotDirtyRef.current = false;
        annotContentSeqRef.current += 1;
        const gate = annotGateRef.current;
        if (discard) {
          // A navigation/rotated token intentionally ends this document: its unconfirmed queue is
          // dropped too (never replayed into the new key).
          const entry = annotPublisherRef.current;
          if (entry) {
            if (entry.queued && entry.queued.dKey === gate.key) entry.queued = null;
            if (entry.pendingDKey === gate.key) {
              entry.dirty = false;
              entry.pendingShapes = null;
              entry.pendingTruncation = null;
            }
          }
        }
        if (annotSyncRef.current.timer) {
          window.clearTimeout(annotSyncRef.current.timer);
          annotSyncRef.current.timer = 0;
        }
        gate.open = false;
        gate.key = '';
        gate.revision = -1;
        gate.context = null;
        gate.d = null;
        gate.scope = null;
        if (exit) {
          annotRef.current.on = false;
          setAnnotOn(false);
        }
        annotSetSyncState('idle');
      }

      /**
       * Local navigation (§12.1): clear locally *and* submit a normal empty document under the old
       * frozen identity; the old content queue is dropped (nothing is replayed into the new key).
       */
      function annotNavigationClear() {
        const identity = annotIdentityNow({ anyEpoch: true });
        annotCancelTransient();
        setAnnotText(null);
        resetAnnotErase();
        setAnnotBusy(false);
        annotShapesRef.current = [];
        annotSelectionRef.current = new Set();
        annotCandidateRef.current = null;
        setAnnotVersion((value) => value + 1);
        annotDirtyRef.current = false;
        annotContentSeqRef.current += 1;
        if (identity) {
          const snapshot = annotBuildSnapshot(identity, {
            shapes: [], truncation: { droppedShapes: 0, droppedPoints: 0, shortenedTextCodeUnits: 0 },
          });
          identity.entry.queued = null;
          annotPublisherQueue(identity.entry, snapshot);
        }
        const gate = annotGateRef.current;
        gate.open = false;
        gate.key = '';
        gate.revision = -1;
        gate.context = null;
        gate.d = null;
        gate.scope = null;
        annotSetSyncState('idle');
      }

      /** Clean + no gesture/edit/in-flight/error → a newer Host revision may replace the view. */
      function annotCanAdopt() {
        if (annotDirtyRef.current) return false;
        if (annotGestureRef.current.active || annotEditRef.current.active || annotEraseRef.current.active
          || annotMoveRef.current.active || annotMarqueeRef.current.active) return false;
        const entry = annotPublisherRef.current;
        if (!entry) return false;
        if (entry.inflight || entry.queued || entry.lastError) return false;
        const state = annotSyncRef.current.state;
        return state !== 'pending' && state !== 'error';
      }

      function annotMaybeAdoptCandidate() {
        const candidate = annotCandidateRef.current;
        if (!candidate) return;
        const gate = annotGateRef.current;
        if (!gate.open || candidate.dKey !== gate.key) {
          annotCandidateRef.current = null;
          return;
        }
        if (!annotCanAdopt()) return;
        if (candidate.revision <= gate.revision) {
          annotCandidateRef.current = null;
          return;
        }
        gate.revision = candidate.revision;
        annotApplyImported(candidate.shapes);
        annotDirtyRef.current = false;
        annotShownRevisionRef.current = Math.max(annotShownRevisionRef.current, candidate.revision);
        annotSetStale(candidate.stale, candidate.staleReason);
        annotSetSyncState('synced');
        annotCandidateRef.current = null;
      }

      /**
       * Hydrate `ui.annotations` after runtime/revision/view acceptance (§12.2). The document is
       * located by the same-response context, never by sessionId or by "most recent" guessing.
       */
      function annotHydrate(ui) {
        const gate = annotGateRef.current;
        if (gate.epoch !== scopeEpochRef.current) return;
        const scopeNow = scopeRef.current;
        if (!scopeNow || scopeNow.legacy) return;
        const doc = ui && ui.annotations;
        const context = ui && ui.annotationContext;
        const d = annotDOf(ui);
        if (!doc || typeof doc !== 'object' || !d) return;
        if (doc.version !== 1 || doc.space !== 'canvas-css-px') return;
        const revision = Number(doc.revision);
        if (!Number.isSafeInteger(revision) || revision < 0) return;
        const shapes = Array.isArray(doc.shapes) ? doc.shapes : [];
        const key = annotDKey(d);
        // A non-empty document must cite exactly the authenticated context (including addressDigest).
        if (shapes.length > 0 && !annotContextMatches(doc.context, context)) {
          if (gate.open && gate.key !== key) annotDropLocalView({ exit: false });
          return;
        }
        const entry = annotPublisherGet(d.scopeId, d.runtimeId, annotSurfaceName());
        // The Host watermark must not be exceeded after a reload/remount (§12.4).
        if (doc.source && doc.source.panelId === entry.panelId
          && Number.isSafeInteger(Number(doc.source.clientRevision))) {
          const watermark = Math.max(0, Number(doc.source.clientRevision));
          if (watermark > entry.clientRevision) {
            entry.clientRevision = watermark;
            annotPublisherPersist(entry);
          }
        }
        annotSetStale(doc.stale, doc.staleReason);
        const viewSnapshot = annotViewSnapshot();
        const firstForDocument = !gate.open || gate.key !== key;
        if (firstForDocument) {
          annotSubscribePublisher(entry, key);
          gate.open = true;
          gate.key = key;
          gate.revision = revision;
          gate.epoch = scopeEpochRef.current;
          gate.context = Object.assign({}, context);
          gate.d = d;
          gate.scope = scopeNow;
          gate.view = viewSnapshot;
          entry.activeDKey = key;
          entry.activeGeneration = annotMountGenerationRef.current;
          entry.activeEpoch = scopeEpochRef.current;
          if (entry.dirty && entry.pendingDKey === key && Array.isArray(entry.pendingShapes)) {
            // A remount of the same D resumes the unconfirmed content (dirty/error), not the Host copy.
            annotApplyImported(entry.pendingShapes);
            annotDirtyRef.current = true;
            annotContentSeqRef.current = Math.max(annotContentSeqRef.current, entry.pendingContentSeq);
            annotShownRevisionRef.current = Math.max(entry.hostRevision, 0);
            annotSetSyncState(entry.lastError ? 'error' : 'pending');
            return;
          }
          annotApplyImported(shapes);
          annotDirtyRef.current = false;
          annotShownRevisionRef.current = revision;
          annotSetSyncState('synced');
          return;
        }
        gate.view = viewSnapshot;
        if (revision > gate.revision) {
          if (annotCanAdopt()) {
            gate.revision = revision;
            annotApplyImported(shapes);
            annotDirtyRef.current = false;
            annotShownRevisionRef.current = revision;
            if (annotCandidateRef.current && annotCandidateRef.current.revision <= revision) {
              annotCandidateRef.current = null;
            }
            if (!annotSyncRef.current.timer && !entry.inflight && !entry.queued && !entry.lastError) {
              annotSetSyncState('synced');
            }
          } else {
            annotCandidateRef.current = {
              dKey: key,
              revision,
              shapes,
              stale: doc.stale === true,
              staleReason: doc.staleReason || null,
            };
          }
        }
      }

      /** Pick up a newer candidate once a gesture/edit/cancel or ACK made the panel clean again. */
      function annotResumeAfterTransient() {
        if (blenderView) return;
        window.setTimeout(() => {
          annotMaybeAdoptCandidate();
          if (annotChannelRef.current && annotDirtyRef.current && annotGateRef.current.open) annotPublishSchedule();
        }, 0);
      }

      /* ---- 橡皮擦（docs/viewport-control.md）------------------------------------------- */

      function annotEraseRadius(shape) {
        const width = Number(shape.strokeWidth);
        return Math.max(Number.isFinite(width) ? width / 2 : 0, ANNOT_ERASE_MIN_RADIUS);
      }

      function annotSegmentDistance(point, a, b) {
        const dx = b.x - a.x;
        const dy = b.y - a.y;
        const lengthSq = dx * dx + dy * dy;
        if (!(lengthSq > 0)) return Math.hypot(point.x - a.x, point.y - a.y);
        const t = Math.max(0, Math.min(1, ((point.x - a.x) * dx + (point.y - a.y) * dy) / lengthSq));
        return Math.hypot(point.x - (a.x + t * dx), point.y - (a.y + t * dy));
      }

      /** Inside-or-on one triangle (the arrow head is a filled triangle, not a line). */
      function annotPointInTriangle(point, triangle) {
        if (!triangle || triangle.length !== 3) return false;
        const cross = (a, b) => (b.x - a.x) * (point.y - a.y) - (b.y - a.y) * (point.x - a.x);
        const d1 = cross(triangle[0], triangle[1]);
        const d2 = cross(triangle[1], triangle[2]);
        const d3 = cross(triangle[2], triangle[0]);
        const hasNegative = d1 < -1e-9 || d2 < -1e-9 || d3 < -1e-9;
        const hasPositive = d1 > 1e-9 || d2 > 1e-9 || d3 > 1e-9;
        return !(hasNegative && hasPositive);
      }

      function annotHitContext() {
        if (annotHitCtxRef.current) return annotHitCtxRef.current;
        try {
          const canvas = document.createElement('canvas');
          canvas.width = 1;
          canvas.height = 1;
          annotHitCtxRef.current = canvas.getContext('2d');
        } catch { annotHitCtxRef.current = null; }
        return annotHitCtxRef.current;
      }
