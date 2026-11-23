    /* ------------------------------------------------------------------------------------------
     * Preview frame transport.
     *
     * Capture stays in the Host (CDP Page.startScreencast). This layer only receives the newest
     * frame and reports measured timing:
     *   - preferred: same-origin WebSocket `/plugins/ui-testing/frames` (server push, binary JPEG)
     *   - fallback : existing `GET /frame?since=N` polling (compatibility path)
     *
     * Wire format for the WebSocket: text hello, then binary [uint32BE metaLen][JSON meta][JPEG].
     * Polling responses carry the same metadata fields (seq/epoch/capturedAt/width/height).
     * The transport is deliberately UI-free; React only subscribes to frames/states.
     * ---------------------------------------------------------------------------------------- */
    const FRAME_POLL_MS = 80;
    const WS_RETRY_MIN_MS = 800;
    const WS_RETRY_MAX_MS = 15000;
    const WS_OPEN_TIMEOUT_MS = 4000;
    const SEED_DELAY_MS = 700;
    const SEED_DEBOUNCE_MS = 200;
    /** How long a canvas barrier must stay mismatched before the client refreshes the PNG seed. */
    const SEED_STALE_MS = 650;
    /**
     * Barrier reasons that may legitimately be repaired by one bounded composed-seed request.
     * `frame-scroll-missing` / `no-frame` are new: without them a live page whose frame lost its
     * scroll metadata stayed fail-closed forever. A request is only made while a target is running.
     */
    const SEED_REFRESH_REASONS = new Set([
      'page-size-mismatch', 'scroll-mismatch', 'seed-stale', 'seed-provenance-missing',
      'frame-scroll-missing', 'no-frame',
    ]);

    function frameSocketUrl(scope) {
      const scheme = location.protocol === 'https:' ? 'wss:' : 'ws:';
      let query = '?scopeVersion=' + SCOPE_VERSION;
      if (scope && scope.kind === 'session' && scope.sessionId) query += '&sessionId=' + encodeURIComponent(scope.sessionId) + '&tab=primary';
      else if (scope && scope.binding) query += '&binding=' + encodeURIComponent(scope.binding);
      else query += '&scope=recent';
      return scheme + '//' + location.host + HOST_BASE + '/frames' + query;
    }

    function blobFromBase64(base64, type) {
      const binary = atob(base64 || '');
      const bytes = new Uint8Array(binary.length);
      for (let index = 0; index < binary.length; index += 1) bytes[index] = binary.charCodeAt(index);
      return new Blob([bytes], { type: type || 'image/jpeg' });
    }

    function parsePushedFrame(buffer) {
      if (!buffer || buffer.byteLength < 5) return null;
      const view = new DataView(buffer);
      const headerLength = view.getUint32(0);
      if (!headerLength || headerLength > buffer.byteLength - 4) return null;
      const header = JSON.parse(new TextDecoder().decode(new Uint8Array(buffer, 4, headerLength)));
      if (!header || header.v !== 1) return null;
      return { meta: header, blob: new Blob([buffer.slice(4 + headerLength)], { type: 'image/jpeg' }) };
    }

    /**
     * @param {{onFrame: (frame: {blob: Blob, meta: object}) => void,
     *          onState: (state: object) => void,
     *          onTransport: (kind: 'ws'|'poll') => void,
     *          canWrite?: () => boolean}} handlers
     * @param {object} scope Immutable scope/binding snapshot for every request and the WS.
     */
    function createFrameTransport(handlers, scope) {
      let closed = false;
      const controller = typeof AbortController === 'function' ? new AbortController() : null;
      const signal = controller ? controller.signal : undefined;
      let socket;
      let socketTimer = 0;
      let pollTimer = 0;
      let pollBusy = false;
      let retryTimer = 0;
      let retryDelay = WS_RETRY_MIN_MS;
      let kind = 'poll';
      let lastSeq = -1;
      let lastEpoch = -1;
      let lastState;
      let urlSince = 0;
      // PNG seed state (see the seed block below): signature of the last requested shell state and
      // a bounded diagnostic counter set. `seedStats` is evidence-only and never an assertion.
      let seedContext = null;
      let seedKey = '';
      let seedRequestedKey = '';
      let seedScheduledKey = '';
      let seedScheduledForce = false;
      let seedForceKey = '';
      let seedWarnedKey = '';
      let seedPending = false;
      let seedTimer = 0;
      let lastManualSeedAt = 0;
      const seedStats = { requested: 0, accepted: 0, stale: 0, invalid: 0, failed: 0, forced: 0, manual: 0 };
      const stats = {
        transport: 'poll',
        received: 0,
        droppedClient: 0,
        transportMs: 0,
        seeded: 0,
        lastMeta: null,
        hostDropped: null,
      };

      function emitTransport() {
        stats.transport = kind;
        try { handlers.onTransport(kind); } catch { /* UI must not break transport */ }
      }

      function accept(meta, blob) {
        const seq = Number(meta && meta.seq);
        const epoch = Number(meta && meta.epoch);
        if (Number.isFinite(epoch) && epoch < lastEpoch) {
          stats.droppedClient += 1;
          return;
        }
        if (Number.isFinite(epoch) && epoch === lastEpoch && Number.isFinite(seq) && seq <= lastSeq) return;
        if (Number.isFinite(epoch) && epoch === lastEpoch && Number.isFinite(seq) && lastSeq >= 0 && seq > lastSeq + 1) {
          stats.droppedClient += seq - lastSeq - 1;
        }
        if (Number.isFinite(seq)) lastSeq = seq;
        if (Number.isFinite(epoch)) lastEpoch = Math.max(lastEpoch, epoch);
        stats.received += 1;
        if (Number(meta && meta.capturedAtMs) > 0) {
          stats.transportMs = Math.max(0, Date.now() - Number(meta.capturedAtMs));
        }
        stats.lastMeta = meta || null;
        if (meta && meta.dropped) stats.hostDropped = meta.dropped;
        try { handlers.onFrame({ blob, meta: meta || {} }); } catch { /* ignore */ }
      }

      function noteState(state) {
        if (!state || closed) return;
        if (!lastState || lastState.url !== state.url) {
          lastState = state;
          urlSince = Date.now();
        } else {
          lastState = state;
        }
        scheduleSeed();
      }

      /* ---- PNG seed for static pages (no screencast damage after load) ------------------------
       *
       * A seed is a /screenshot of the current canvas view. On a canvas Host it must be provably
       * composited at the C/S/revision/scale it was requested for (docs/viewport-control.md);
       * the React side publishes `updateSeedContext()` on every accepted state and the transport
       * refreshes the seed when that context moves. Same shell state is requested at most once; an
       * incomplete response or a stale capture is dropped and leaves canvas input fail-closed.
       * -------------------------------------------------------------------------------------- */

      function seedKeyOf(context) {
        if (!context) return '';
        const url = String(context.url || (lastState && lastState.url) || '');
        if (context.legacy) return 'legacy|' + url;
        const round = (value) => (Number.isFinite(Number(value)) ? Math.round(Number(value) * 100) / 100 : null);
        return [
          url,
          round(context.canvasX), round(context.canvasY),
          round(context.scrollX), round(context.scrollY),
          Number.isFinite(Number(context.viewRevision)) ? Number(context.viewRevision) : null,
          round(context.scale),
          round(context.width), round(context.height),
        ].join('|');
      }

      /** Publish the shell canvas/scroll/scale signature; called after every accepted snapshot. */
      function updateSeedContext(context) {
        if (closed) return;
        seedContext = context || null;
        if (!seedContext) return;
        seedKey = seedKeyOf(seedContext);
        if (seedForceKey && seedForceKey !== seedKey) seedForceKey = '';
        scheduleSeed();
      }

      /**
       * React asks for a fresh composed seed after a sustained barrier mismatch (page-size / scroll /
       * seed-stale / missing frame evidence). This may run even after live frames were received.
       */
      function requestSeedRefresh(context) {
        if (closed || !context) return;
        seedContext = context;
        seedKey = seedKeyOf(context);
        seedForceKey = seedKey;
        scheduleSeed();
      }

      /**
       * Explicit user "retry sync": the one automatic attempt per shell signature is cleared, but
       * the request stays single-flight and throttled. This never invents a view revision or writes
       * Runtime lastError.
       */
      function retrySeedRefresh(context) {
        if (closed || !context) return false;
        const now = Date.now();
        if (now - lastManualSeedAt < 1000) return false;
        lastManualSeedAt = now;
        seedContext = context;
        seedKey = seedKeyOf(context);
        seedRequestedKey = '';
        seedWarnedKey = '';
        seedForceKey = seedKey;
        seedStats.manual += 1;
        scheduleSeed();
        return true;
      }

      function notifySeedStatus(status) {
        try { if (handlers.onSeedStatus) handlers.onSeedStatus(status); } catch { /* UI must not break transport */ }
      }

      function warnSeed(reason) {
        notifySeedStatus({ state: 'failed', reason });
        if (seedWarnedKey === seedRequestedKey) return;
        seedWarnedKey = seedRequestedKey;
        console.warn('ui-testing: seed screenshot rejected (' + reason + '); canvas input stays fail-closed');
      }

      function scheduleSeed() {
        if (closed || !seedContext || !seedKey) return;
        const force = seedForceKey === seedKey;
        // The historical seed only applies before the first live frame; a React-driven refresh is
        // allowed after live frames when the displayed frame can no longer prove the canvas.
        if (!force && stats.received > 0) return;
        if (handlers.canWrite && !handlers.canWrite()) return;
        if (seedRequestedKey === seedKey) { if (force) seedForceKey = ''; return; } // one attempt per shell state
        if (seedPending) return; // the completion schedules the latest pending signature
        if (seedTimer && seedScheduledKey === seedKey) return; // do not restart our own debounce
        if (seedTimer) window.clearTimeout(seedTimer);
        // A URL change keeps the historical settle delay; later canvas/scroll moves use a short
        // debounce so a drag does not request a composition per pointer move.
        const sinceUrl = Date.now() - urlSince;
        const delay = Math.max(SEED_DEBOUNCE_MS, sinceUrl < SEED_DELAY_MS ? SEED_DELAY_MS - sinceUrl : 0);
        seedScheduledKey = seedKey;
        seedScheduledForce = force;
        seedTimer = window.setTimeout(() => {
          seedTimer = 0;
          seedScheduledKey = '';
          requestSeed(seedScheduledForce);
          seedScheduledForce = false;
        }, delay);
      }

      /** Extract the composited-at-canvas provenance from /screenshot; null when insufficient. */
      function seedFactsFrom(payload) {
        if (!payload || !payload.image) return null;
        const object = (value) => (value && typeof value === 'object' ? value : null);
        const view = object(payload.view) || object(payload.state && payload.state.ui && payload.state.ui.view);
        const capture = object(payload.capture);
        const mapping = object(payload.mapping) || object(capture && capture.mapping);
        const canvas = object(payload.canvas) || object(capture && capture.canvas) || object(mapping && mapping.canvas);
        const viewport = object(capture && capture.viewport) || object(payload.viewport);
        const mappingScroll = object(mapping && mapping.scrollAtCapture);
        const num = (value) => (value === null || value === undefined || value === '' ? null : (Number.isFinite(Number(value)) ? Number(value) : null));
        // Capture-time evidence wins over the current view projection (the latter may have advanced
        // between the request and the capture). Missing evidence is never replaced by an assumption.
        const canvasX = num(canvas && canvas.x) ?? num(view && view.canvasX);
        const canvasY = num(canvas && canvas.y) ?? num(view && view.canvasY);
        const scrollX = num(canvas && canvas.scrollX) ?? num(view && view.x) ?? num(mappingScroll && mappingScroll.x);
        const scrollY = num(canvas && canvas.scrollY) ?? num(view && view.y) ?? num(mappingScroll && mappingScroll.y);
        const viewRevision = num(capture && capture.viewRevision) ?? num(view && view.revision) ?? num(payload.viewRevision);
        const scale = num(capture && capture.requestedScale) ?? num(view && view.scale) ?? num(payload.scale);
        const width = num(viewport && viewport.width) ?? num(view && view.width) ?? num(payload.width);
        const height = num(viewport && viewport.height) ?? num(view && view.height) ?? num(payload.height);
        // Content box is optional for the barrier but needed to clip a composed seed so the panel
        // can show its checkerboard instead of the Host's evidence-white blank.
        const contentWidth = num(canvas && canvas.contentWidth) ?? num(mapping && mapping.canvas && mapping.canvas.contentWidth);
        const contentHeight = num(canvas && canvas.contentHeight) ?? num(mapping && mapping.canvas && mapping.canvas.contentHeight);
        if ([canvasX, canvasY, scrollX, scrollY, viewRevision, scale, width, height].some((value) => value === null)) return null;
        return { canvasX, canvasY, scrollX, scrollY, viewRevision, scale, width, height, contentWidth, contentHeight };
      }

      function seedFactsMatch(facts, context) {
        if (!facts || !context || context.legacy) return false;
        const near = (a, b, tolerance) => Number.isFinite(Number(a)) && Number.isFinite(Number(b)) && Math.abs(Number(a) - Number(b)) <= tolerance;
        return near(facts.canvasX, context.canvasX, 1)
          && near(facts.canvasY, context.canvasY, 1)
          && near(facts.scrollX, context.scrollX, 1)
          && near(facts.scrollY, context.scrollY, 1)
          && Number(facts.viewRevision) === Number(context.viewRevision)
          && near(facts.scale, context.scale, 0.001)
          && near(facts.width, context.width, 1)
          && near(facts.height, context.height, 1);
      }

      function requestSeed(force) {
        if (closed || !seedContext || !seedKey) return;
        if (!force && stats.received > 0) return;
        if (seedRequestedKey === seedKey || seedPending) return;
        if (handlers.canWrite && !handlers.canWrite()) return;
        if (seedForceKey === seedKey) seedForceKey = '';
        const requestedKey = seedKey;
        const requestedContext = seedContext;
        seedRequestedKey = requestedKey;
        seedPending = true;
        seedStats.requested += 1;
        if (force) seedStats.forced += 1;
        // A canvas seed must be composed at C (docs/viewport-control.md); an old Host keeps the
        // historical plain-page screenshot request.
        callHost('screenshot', requestedContext.legacy ? {} : { canvas: true }, { scope, signal }).then((payload) => {
          if (closed) return;
          if (!payload || !payload.image) {
            // The page is intentionally closed (empty tab state): no seed, no error, no page start.
            if (payload && payload.closed === true) return;
            seedStats.failed += 1;
            warnSeed('no-image');
            return;
          }
          if (requestedContext.legacy) {
            // Historical plain-page seed (old Host / no canvas): no canvas provenance to claim.
            const meta = {
              seed: true,
              seq: 0,
              epoch: lastEpoch < 0 ? 0 : lastEpoch,
              capturedAtMs: payload.capturedAt,
              width: payload.viewport && payload.viewport.width,
              height: payload.viewport && payload.viewport.height,
              pageWidth: payload.viewport && payload.viewport.width,
              pageHeight: payload.viewport && payload.viewport.height,
            };
            stats.seeded += 1;
            stats.lastMeta = meta;
            notifySeedStatus({ state: 'ok', reason: null });
            try { handlers.onFrame({ blob: blobFromBase64(payload.image, 'image/png'), meta }); } catch { /* UI must not break transport */ }
            return;
          }
          const facts = seedFactsFrom(payload);
          if (!facts) { seedStats.invalid += 1; warnSeed('provenance-missing'); return; }
          // The response is only usable while the shell is still on the exact signature requested,
          // and the Host must prove it composited at that same C/S/revision/scale.
          if (!seedContext || requestedKey !== seedKeyOf(seedContext)) { seedStats.stale += 1; return; }
          if (!seedFactsMatch(facts, requestedContext)) { seedStats.invalid += 1; warnSeed('provenance-mismatch'); return; }
          const meta = {
            seed: true,
            // The PNG is the canvas view (composited at C or the O=0 single native capture): the
            // client must not apply the live-frame displacement on top of it.
            seedComposite: true,
            seq: 0,
            epoch: lastEpoch < 0 ? 0 : lastEpoch,
            capturedAtMs: payload.capturedAt,
            width: facts.width,
            height: facts.height,
            pageWidth: facts.width,
            pageHeight: facts.height,
            // The seed image is already composited at C: the preview must not translate it, but the
            // barrier compares these facts with the live C/S/revision to refuse stale pixels.
            seedCanvasX: facts.canvasX,
            seedCanvasY: facts.canvasY,
            seedScrollX: facts.scrollX,
            seedScrollY: facts.scrollY,
            seedViewRevision: facts.viewRevision,
            seedScale: facts.scale,
            seedWidth: facts.width,
            seedHeight: facts.height,
            seedContentWidth: facts.contentWidth,
            seedContentHeight: facts.contentHeight,
          };
          stats.seeded += 1;
          seedStats.accepted += 1;
          stats.lastMeta = meta;
          notifySeedStatus({ state: 'ok', reason: null });
          try { handlers.onFrame({ blob: blobFromBase64(payload.image, 'image/png'), meta }); } catch { /* UI must not break transport */ }
        }).catch((error) => {
          if (error && error.name === 'AbortError') return;
          seedStats.failed += 1;
          notifySeedStatus({ state: 'failed', reason: 'request-failed' });
        }).finally(() => {
          seedPending = false;
          if (closed) return;
          // A context change while the request was in flight gets exactly one follow-up request;
          // outside the initial seed this only happens when React flagged the new key for refresh.
          if (seedKey && seedRequestedKey !== seedKey && (stats.received === 0 || seedForceKey === seedKey)) scheduleSeed();
        });
      }

      function stopPolling() {
        if (pollTimer) window.clearTimeout(pollTimer);
        pollTimer = 0;
      }

      async function pollOnce() {
        pollTimer = 0;
        if (closed || kind === 'ws' || pollBusy) return;
        pollBusy = true;
        try {
          const response = await fetch(HOST_BASE + '/frame?since=' + Math.max(0, lastSeq), { credentials: 'same-origin', headers: scopeHeaders(scope), signal });
          if (response.ok) {
            const payload = await response.json();
            if (payload.state) {
              // The transport only ever needs the redacted url (seed decision): the raw address
              // never enters transport state, metrics or error text.
              noteState({ url: payload.state.url });
              try { handlers.onState(payload.state); } catch { /* ignore */ }
            }
            if (!payload.pending && payload.image) {
              const epoch = Number(payload.epoch) || 0;
              const seq = Number(payload.seq) || 0;
              if (epoch > lastEpoch || (epoch === lastEpoch && seq > lastSeq)) {
                accept({
                  seq,
                  epoch,
                  transport: 'poll',
                  capturedAtMs: payload.capturedAt,
                  receivedAtMs: payload.receivedAt,
                  width: payload.width,
                  height: payload.height,
                  pageWidth: payload.pageWidth,
                  pageHeight: payload.pageHeight,
                  // P0-C v2 frame metadata (docs/viewport-control.md): the capture-time top-level
                  // scroll, needed to composite the canvas view and to prove input freshness.
                  scrollX: payload.scrollX,
                  scrollY: payload.scrollY,
                  format: 'jpeg',
                }, blobFromBase64(payload.image, 'image/jpeg'));
              }
            }
          }
        } catch { /* runtime not started or transient network error */ }
        pollBusy = false;
        if (!closed && kind !== 'ws') {
          scheduleSeed();
          pollTimer = window.setTimeout(pollOnce, FRAME_POLL_MS);
        }
      }

      function startPolling() {
        if (closed || kind === 'ws' || pollBusy || pollTimer) return;
        pollTimer = window.setTimeout(pollOnce, 0);
      }

      function scheduleRetry() {
        if (closed) return;
        if (retryTimer) window.clearTimeout(retryTimer);
        retryTimer = window.setTimeout(() => {
          retryTimer = 0;
          connectSocket();
        }, retryDelay);
        retryDelay = Math.min(WS_RETRY_MAX_MS, Math.round(retryDelay * 1.8));
      }

      function connectSocket() {
        if (closed) return;
        let next;
        try {
          next = new WebSocket(frameSocketUrl(scope));
          next.binaryType = 'arraybuffer';
        } catch { scheduleRetry(); return; }
        socket = next;
        socketTimer = window.setTimeout(() => {
          if (socket === next && next.readyState === 0) {
            try { next.close(); } catch { /* ignore */ }
          }
        }, WS_OPEN_TIMEOUT_MS);
        next.onopen = () => {
          if (closed || socket !== next) return;
          window.clearTimeout(socketTimer);
          socketTimer = 0;
          retryDelay = WS_RETRY_MIN_MS;
          kind = 'ws';
          emitTransport();
          stopPolling();
        };
        next.onmessage = (event) => {
          if (closed || socket !== next) return;
          if (typeof event.data === 'string') {
            try {
              const message = JSON.parse(event.data);
              if (message && message.type === 'hello') {
                kind = 'ws';
                emitTransport();
                if (typeof handlers.onHello === 'function') {
                  try { handlers.onHello(message); } catch { /* UI must not break transport */ }
                }
              } else if (message && message.type === 'audio') {
                // Page audio rides the same socket as the frames but on its own timeline
                // (docs/web/debug-panel.md). Decoding/playback lives in the panel player.
                try { handlers.onAudio(message); } catch { /* a bad packet must not break frames */ }
              }
            } catch { /* ignore malformed control message */ }
            return;
          }
          try {
            const parsed = parsePushedFrame(event.data);
            if (parsed) {
              kind = 'ws';
              accept(parsed.meta, parsed.blob);
            }
          } catch { /* ignore malformed binary frame */ }
        };
        next.onerror = () => {
          if (socket === next) {
            try { next.close(); } catch { /* ignore */ }
          }
        };
        next.onclose = () => {
          window.clearTimeout(socketTimer);
          socketTimer = 0;
          if (socket === next) socket = undefined;
          if (closed) return;
          if (kind === 'ws') {
            kind = 'poll';
            emitTransport();
          }
          startPolling();
          scheduleRetry();
        };
      }

      return {
        start() {
          connectSocket();
          startPolling();
        },
        close() {
          closed = true;
          if (controller) {
            try { controller.abort(); } catch { /* ignore */ }
          }
          window.clearTimeout(socketTimer);
          window.clearTimeout(retryTimer);
          if (seedTimer) window.clearTimeout(seedTimer);
          socketTimer = 0;
          retryTimer = 0;
          seedTimer = 0;
          stopPolling();
          if (socket) {
            try { socket.close(); } catch { /* ignore */ }
            socket = undefined;
          }
        },
        noteState,
        updateSeedContext,
        requestSeedRefresh,
        retrySeedRefresh,
        stats() {
          return {
            transport: kind,
            received: stats.received,
            droppedClient: stats.droppedClient,
            transportMs: stats.transportMs,
            seeded: stats.seeded,
            lastSeq,
            lastEpoch,
            lastMeta: stats.lastMeta,
            hostDropped: stats.hostDropped,
            seed: { ...seedStats },
          };
        },
      };
    }

    /* ------------------------------------------------------------------------------------------
     * Workspace scope binding for the panel.
     *
     * The right sidebar tab is session-scoped and receives the standard `sessionId` prop. The
     * root-scoped main panel has no Session binding: `MoreRow` remembers the session that owns the
     * main view right before `layout.selectPanel`, and `DebugView` reads that memory. With no
     * capture the panel asks the Host for `recent` once, then pins every request/WS to the Host
     * provided runtime binding so a later request cannot drift to another workspace.
     * ---------------------------------------------------------------------------------------- */
