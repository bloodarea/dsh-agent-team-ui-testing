    const SVG_NS = 'http://www.w3.org/2000/svg';
    /** P0-D annotation defaults (docs/viewport-control.md). */
    const ANNOT_DEFAULT = Object.freeze({ tool: 'rect', color: '#ff3b30', width: 3, fill: false, stroke: true });
    /**
     * 用户 2026-11-03 第 1 条：填充/外框是互斥选择（单一真源 mode）。非闭合工具与文字按工具
     * 冻结样式，只有圆形/矩形跟随 mode；橡皮擦不产出图形。Host 契约不变（仍是 fill/stroke 布尔）。
     */
    function annotStyleFor(tool, mode) {
      if (tool === 'text') return { fill: true, stroke: false };
      if (tool === 'line' || tool === 'arrow' || tool === 'brush') return { fill: false, stroke: true };
      return mode === 'fill' ? { fill: true, stroke: false } : { fill: false, stroke: true };
    }
    /**
     * 选择类工具（v3，2026-11-12）：只改面板本地选中态，不产生图形、不写 Host 文档。
     * `select` 点选/拖动已选图形，`marquee` 用矩形框选多个；两者与绘制/橡皮擦/文字互斥。
     */
    const ANNOT_SELECTION_TOOLS = Object.freeze(['select', 'marquee']);
    function annotIsSelectionTool(tool) {
      return ANNOT_SELECTION_TOOLS.includes(tool);
    }
    const ANNOT_TOOLS = Object.freeze([
      // 选择/框选放在工具栏最左侧（用户 2026-11-12 要求），绘制工具的相对顺序不变。
      Object.freeze({ id: 'select', label: '选择' }),
      Object.freeze({ id: 'marquee', label: '框选' }),
      Object.freeze({ id: 'circle', label: '圆形' }),
      Object.freeze({ id: 'rect', label: '矩形' }),
      Object.freeze({ id: 'line', label: '线段' }),
      Object.freeze({ id: 'arrow', label: '箭头' }),
      Object.freeze({ id: 'brush', label: '画笔' }),
      Object.freeze({ id: 'text', label: '文字' }),
      // 第七个工具（v2，docs/viewport-control.md）：单选、与其他六个互斥、不产生图形。
      Object.freeze({ id: 'eraser', label: '橡皮擦' }),
    ]);
    /** P0-D v2 上报（docs/viewport-control.md）：150ms trailing 合并、500ms 单次重试。 */
    const ANNOT_PUBLISH_DEBOUNCE_MS = 150;
    const ANNOT_PUBLISH_RETRY_MS = 500;
    /** 橡皮擦命中半径 r=max(strokeWidth/2,6) 画布 CSS px；长拖插值步长 ≤3 画布 px（§11.4）。 */
    const ANNOT_ERASE_MIN_RADIUS = 6;
    const ANNOT_ERASE_STEP_PX = 3;
    /** 软限额（§11.2）：客户端与 Host 同一确定性规则；客户端先裁剪并如实上报 truncation。 */
    const ANNOT_LIMITS = Object.freeze({
      shapes: 128,
      brushPoints: 512,
      documentPoints: 8192,
      textChars: 200,
      bytes: 65536,
    });

    /* ------------------------------------------------------------------------------------------
     * P0-D v3 标注工作区保留（docs/viewport-control.md）。
     *
     * The Host already stores one annotation document per workspace Runtime and already isolates
     * workspaces. The client's remaining jobs are:
     *   1. hydrate `ui.annotations` into the panel (after the runtime/revision/view acceptance);
     *   2. never turn "this panel unmounted / this tab hid / the scope changed" into an empty
     *      `release` document (that used to erase the workspace document on the Host);
     *   3. keep unacknowledged content + the publisher identity in module-level state so a remount
     *      can continue where the previous mount stopped, without depending on React state.
     *
     * `annotPublishers` is keyed by the authenticated opaque scope id + runtimeId + surface, i.e.
     * one logical publisher per workspace/runtime/panel-seat. `sessionStorage` persists only the
     * panel UUID and the last allocated clientRevision (never paths, session ids or shapes).
     * ---------------------------------------------------------------------------------------- */
    const ANNOT_STORAGE_PREFIX = 'dsh.ui-testing.annotations.v3';
    const ANNOT_ID_PATTERN = /^a[1-9][0-9]{0,15}$/;
    const ANNOT_UUID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
    const annotPublishers = new Map();
    let annotMountSerial = 0;

    function annotNewUuid() {
      let id = '';
      try {
        if (typeof crypto !== 'undefined' && crypto && typeof crypto.randomUUID === 'function') id = String(crypto.randomUUID());
      } catch { id = ''; }
      if (ANNOT_UUID_PATTERN.test(id)) return id;
      const hex = (count) => {
        let text = '';
        for (let index = 0; index < count; index += 1) text += Math.floor(Math.random() * 16).toString(16);
        return text;
      };
      return hex(8) + '-' + hex(4) + '-4' + hex(3) + '-a' + hex(3) + '-' + hex(12);
    }

    function annotStorageKey(scopeId, runtimeId, surface) {
      return [ANNOT_STORAGE_PREFIX, String(scopeId || ''), String(runtimeId || ''), String(surface || 'main')].join('|');
    }

    /** sessionStorage is optional: a blocked/absent store degrades to the module registry (§12.4). */
    function annotStorageRead(key) {
      try {
        const raw = window.sessionStorage.getItem(key);
        if (!raw) return null;
        const parsed = JSON.parse(raw);
        return parsed && typeof parsed === 'object' ? parsed : null;
      } catch { return null; }
    }

    function annotStorageWrite(key, value) {
      try { window.sessionStorage.setItem(key, JSON.stringify(value)); } catch { /* degrade */ }
    }

    function annotPublisherGet(scopeId, runtimeId, surface) {
      const key = annotStorageKey(scopeId, runtimeId, surface);
      let entry = annotPublishers.get(key);
      if (entry) return entry;
      const stored = annotStorageRead(key) || {};
      const storedRevision = Number.isSafeInteger(stored.lastAllocatedClientRevision)
        ? Math.max(0, stored.lastAllocatedClientRevision) : 0;
      const panelId = typeof stored.panelId === 'string' && ANNOT_UUID_PATTERN.test(stored.panelId)
        ? stored.panelId : annotNewUuid();
      entry = {
        key, panelId, surface: String(surface || 'main'),
        clientRevision: storedRevision,
        // Visible/queue bookkeeping (module-owned so an unmount cannot lose it).
        queued: null, inflight: null, retryTimer: 0, retried: false,
        dirty: false, pendingShapes: null, pendingTruncation: null, pendingContentSeq: 0, pendingDKey: '',
        lastError: false,
        hostRevision: 0, ackedClientRevision: 0,
        activeDKey: '', activeGeneration: 0, activeEpoch: -1,
        subscribers: new Set(),
      };
      annotPublishers.set(key, entry);
      if (stored.panelId !== panelId || storedRevision !== entry.clientRevision) {
        annotStorageWrite(key, { panelId, lastAllocatedClientRevision: entry.clientRevision });
      }
      return entry;
    }

    /** Persist *before* the request: a reload must never reuse an already-sent revision (§12.4). */
    function annotPublisherPersist(entry) {
      annotStorageWrite(entry.key, { panelId: entry.panelId, lastAllocatedClientRevision: entry.clientRevision });
    }

    function annotPublisherAllocate(entry) {
      entry.clientRevision = Math.max(0, Math.floor(entry.clientRevision)) + 1;
      annotPublisherPersist(entry);
      return entry.clientRevision;
    }

    function annotPublisherSubscribe(entry, listener) {
      entry.subscribers.add(listener);
      return () => entry.subscribers.delete(listener);
    }

    function annotPublisherEmit(entry, event) {
      for (const listener of [...entry.subscribers]) {
        try { listener(event); } catch { /* a subscriber must not break the queue */ }
      }
    }

    /** Remember the newest unconfirmed local content without queueing a request. */
    function annotPublisherRemember(entry, facts) {
      entry.dirty = true;
      entry.pendingShapes = facts.shapes;
      entry.pendingTruncation = facts.truncation || { droppedShapes: 0, droppedPoints: 0, shortenedTextCodeUnits: 0 };
      entry.pendingContentSeq = facts.contentSeq;
      entry.pendingDKey = facts.dKey || entry.pendingDKey;
    }

    /** Enqueue the newest snapshot (at most one waiting) and drain. */
    function annotPublisherQueue(entry, snapshot) {
      annotPublisherRemember(entry, {
        shapes: snapshot.shapes,
        truncation: snapshot.truncation,
        contentSeq: snapshot.contentSeq,
        dKey: snapshot.dKey,
      });
      entry.queued = snapshot;
      entry.lastError = false;
      annotPublisherDrain(entry);
    }

    function annotPublisherBody(snapshot) {
      return {
        version: 1,
        panelId: snapshot.panelId,
        surface: snapshot.surface,
        clientRevision: snapshot.clientRevision,
        context: snapshot.context,
        view: snapshot.view,
        shapes: snapshot.release ? [] : snapshot.shapes,
        truncation: snapshot.truncation,
        release: Boolean(snapshot.release),
      };
    }

    function annotPublisherDrain(entry) {
      if (!entry || entry.inflight || !entry.queued) return;
      const snapshot = entry.queued;
      entry.queued = null;
      entry.inflight = snapshot;
      annotPublisherSend(entry, snapshot, false);
    }

    async function annotPublisherSend(entry, snapshot, isRetry) {
      let status = 0;
      let payload = null;
      let failure = null;
      try {
        const response = await fetch(HOST_BASE + '/annotations', {
          method: 'POST',
          headers: Object.assign({ 'content-type': 'application/json' }, scopeHeaders(snapshot.scope)),
          credentials: 'same-origin',
          body: JSON.stringify(annotPublisherBody(snapshot)),
        });
        status = Number(response.status) || 0;
        payload = await response.json().catch(() => ({}));
      } catch (error) {
        failure = error;
      }
      if (entry.inflight === snapshot) entry.inflight = null;
      const current = () => snapshot.dKey === entry.activeDKey
        || (entry.activeDKey === '' && snapshot.clientRevision === entry.clientRevision);
      if (!failure && status === 200 && payload && payload.ok !== false) {
        const accepted = payload.annotations && typeof payload.annotations === 'object' ? payload.annotations : null;
        if (accepted && Number.isSafeInteger(Number(accepted.revision))) {
          entry.hostRevision = Math.max(entry.hostRevision, Math.max(0, Number(accepted.revision)));
        }
        const ackedRevision = Number.isFinite(Number(payload.clientRevision))
          ? Number(payload.clientRevision) : Number(snapshot.clientRevision);
        if (Number.isSafeInteger(ackedRevision) && ackedRevision > 0) {
          entry.ackedClientRevision = Math.max(entry.ackedClientRevision, ackedRevision);
        }
        entry.lastError = false;
        if (snapshot.contentSeq === entry.pendingContentSeq) {
          entry.dirty = false;
          entry.pendingShapes = null;
          entry.pendingTruncation = null;
        }
        annotPublisherEmit(entry, { type: 'ack', snapshot, annotations: accepted, ignored: payload.ignored === true, current: current() });
        annotPublisherDrain(entry);
        return;
      }
      const reason = payload && typeof payload === 'object'
        ? (payload.reason || (payload.details && payload.details.reason))
        : '';
      if (status === 409 && reason === 'annotation-context-stale') {
        // Only the stale document's queue is discarded; another workspace keeps its content.
        if (snapshot.dKey === entry.activeDKey || entry.activeDKey === '') {
          if (entry.queued && entry.queued.dKey === snapshot.dKey) entry.queued = null;
          if (snapshot.contentSeq >= entry.pendingContentSeq) {
            entry.dirty = false;
            entry.pendingShapes = null;
            entry.pendingTruncation = null;
          }
        }
        entry.lastError = false;
        annotPublisherEmit(entry, { type: 'stale', snapshot, current: current() });
        annotPublisherDrain(entry);
        return;
      }
      const retryable = Boolean(failure) || status >= 500 || status === 0;
      if (retryable && !isRetry) {
        if (entry.retryTimer) window.clearTimeout(entry.retryTimer);
        entry.retryTimer = window.setTimeout(() => {
          entry.retryTimer = 0;
          // Still the newest content for this publisher, and the identity is unchanged: one retry
          // with the exact same revision/body. A newer snapshot replaced it → drop the retry.
          if (entry.inflight || entry.queued) return;
          if (snapshot.clientRevision !== entry.clientRevision) return;
          if (snapshot.dKey !== entry.activeDKey && entry.activeDKey !== '') return;
          entry.inflight = snapshot;
          annotPublisherEmit(entry, { type: 'error', snapshot, final: false, current: current() });
          annotPublisherSend(entry, snapshot, true);
        }, ANNOT_PUBLISH_RETRY_MS);
        // A newer snapshot may already be waiting; it must not be blocked by the old retry timer.
        annotPublisherDrain(entry);
        return;
      }
      entry.lastError = true;
      annotPublisherEmit(entry, { type: 'error', snapshot, final: true, current: current() });
      annotPublisherDrain(entry);
    }
    /** 拖拽视口：移动期间写入共享 view 的最小间隔（Host 一次 set 本身要两帧+稳定读回）。 */
