    /**
     * Web 视图通道：一个视图实例自己的帧流 + 状态轮询 + 种子截图。
     *
     * 这是「视图自己管理连接与轮询」的边界：外壳只负责在视图出现/消失时 `mount` / `unmount`，
     * 通道内部持有 transport、定时器、AbortController 和 objectURL 的清理。无视图环境（空白画布）
     * 根本不 mount，因此不会对仍在运行的目标产生任何帧流、截图或轮询。
     *
     * 依赖全部通过参数注入（不读外壳闭包以外的东西），所以它可以脱离浏览器单测。
     */
    function createWebViewChannel(deps = {}) {
      const {
        createFrameTransport, getHost, ingestHostState, discardBinding,
        scopeRef, visibleRef, writesPausedRef, requestGenerationRef,
        transportRef, frameMetaRef, shotUrlRef,
        setShot, setTransportKind, setSeedStatus,
        playPageAudio = null,
        win = (typeof window !== 'undefined' ? window : globalThis),
        urlApi = (typeof URL !== 'undefined' ? URL : globalThis.URL),
        // Instance teardown must also release what the page thinks the human is still holding:
        // a held key lives in the page until a keyUp arrives, so it is the view instance's job.
        onBeforeUnmount = null,
      } = deps;
      let active = null;

      function releaseFrames() {
        if (shotUrlRef.current) {
          try { urlApi.revokeObjectURL(shotUrlRef.current); } catch { /* ignore */ }
          shotUrlRef.current = '';
        }
        for (const objectUrl of frameMetaRef.current.keys()) {
          try { urlApi.revokeObjectURL(objectUrl); } catch { /* ignore */ }
        }
        frameMetaRef.current.clear();
      }

      /**
       * Start the channel for one view instance.
       *
       * @returns {Function} cleanup (idempotent)
       */
      function mount() {
        if (active) unmount();
        const scopeNow = scopeRef.current;
        let mounted = true;
        // A fresh transport per generation: old frames/object URLs never survive a rebuild.
        releaseFrames();
        setShot('');
        const transport = createFrameTransport({
          onAudio(message) {
            if (!mounted || typeof playPageAudio !== 'function') return;
            try { playPageAudio(message); } catch { /* audio must never break the preview */ }
          },
          onFrame({ blob, meta }) {
            if (!mounted) return;
            const nextUrl = urlApi.createObjectURL(blob);
            frameMetaRef.current.set(nextUrl, meta);
            const previous = shotUrlRef.current;
            shotUrlRef.current = nextUrl;
            setShot(nextUrl);
            if (previous) win.setTimeout(() => {
              try { urlApi.revokeObjectURL(previous); } catch { /* ignore */ }
              frameMetaRef.current.delete(previous);
            }, 2000);
          },
          onState(state) { if (mounted) ingestHostState(state); },
          onTransport(kind) { if (mounted) setTransportKind(kind); },
          onSeedStatus(status) {
            if (!mounted) return;
            setSeedStatus(status && status.state === 'failed'
              ? { reason: String(status.reason || 'unknown') }
              : null);
          },
          canWrite() { return !writesPausedRef.current && visibleRef.current; },
        }, scopeNow);
        transportRef.current = transport;
        transport.start();

        // State polling is decoupled from the frame stream: a still page keeps refreshing its
        // address/runtime state on a fixed interval.
        const controller = new AbortController();
        let cancelled = false;
        let timer = 0;
        async function tick() {
          // Capture the action generation per request, not per poll cycle: a navigation action bumps
          // the generation and must not stop this poller from rescheduling (only stale responses
          // are dropped).
          const generation = requestGenerationRef.current;
          try {
            const state = await getHost('/state', scopeNow, controller.signal);
            if (!cancelled && generation === requestGenerationRef.current) {
              // The transport needs the (redacted) url before the adopted seed context is published,
              // otherwise a URL change would key one seed request under the previous page.
              if (transportRef.current) transportRef.current.noteState({ url: state.url });
              ingestHostState(state);
            }
          } catch (error) {
            if (cancelled || (error && error.name === 'AbortError')) return;
            const code = error && error.code ? String(error.code) : '';
            // A binding whose entry was evicted (idle close) must be re-resolved, not reused.
            if (scopeNow.kind === 'recent' && scopeNow.binding && /SCOPE_NOT_FOUND|BINDING/i.test(code)) {
              discardBinding(scopeNow.binding);
            }
          }
          if (!cancelled) timer = win.setTimeout(tick, 500);
        }
        tick();

        active = {
          stop() {
            mounted = false;
            // Release held keys while the transport can still carry the keyUp events.
            if (typeof onBeforeUnmount === 'function') {
              try { onBeforeUnmount(); } catch { /* teardown is best effort */ }
            }
            cancelled = true;
            win.clearTimeout(timer);
            try { controller.abort(); } catch { /* ignore */ }
            try { transport.close(); } catch { /* ignore */ }
            if (transportRef.current === transport) transportRef.current = null;
            releaseFrames();
          },
        };
        return unmount;
      }

      /** Tear the channel down (idempotent): closes the WS/poll loops and revokes every frame URL. */
      function unmount() {
        const current = active;
        active = null;
        if (current) current.stop();
      }

      return { mount, unmount, get active() { return active !== null; } };
    }
