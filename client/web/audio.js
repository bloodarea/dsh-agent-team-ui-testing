    /**
     * Panel-side page audio (docs/web/debug-panel.md).
     *
     * The Host forwards the page's PCM packets over the same frame socket; this player turns them
     * back into scheduled `AudioBufferSourceNode`s. It is deliberately tiny and independent of the
     * preview:
     *
     *   - one shared instance per panel (switching tabs does not re-negotiate the AudioContext);
     *   - the AudioContext is created on the user's first "turn sound on" click, because browsers
     *     refuse to start audio without a gesture;
     *   - packets are scheduled back to back with a small cushion; a player that falls behind
     *     (tab hidden, main thread busy) drops the backlog instead of drifting further behind;
     *   - a `reset` packet (navigation / page close) clears the timeline so the new page starts
     *     clean instead of continuing the old buffer queue.
     */
    function createPanelAudioPlayer(win = (typeof window !== 'undefined' ? window : globalThis)) {
      const listeners = new Set();
      let ctx = null;
      let gain = null;
      let enabled = false;
      let nextTime = 0;
      const stats = {
        enabled: false, packets: 0, played: 0, dropped: 0, decodeErrors: 0, resets: 0,
        bytes: 0, lastError: null, lastPacketAt: 0, sampleRate: null,
      };

      function snapshot() {
        return {
          enabled,
          live: stats.lastPacketAt > 0 && (Date.now() - stats.lastPacketAt) <= 1500,
          packets: stats.packets,
          played: stats.played,
          dropped: stats.dropped,
          decodeErrors: stats.decodeErrors,
          resets: stats.resets,
          bytes: stats.bytes,
          lastError: stats.lastError,
          sampleRate: stats.sampleRate,
        };
      }
      function emit() {
        const value = snapshot();
        for (const listener of listeners) {
          try { listener(value); } catch { /* ignore */ }
        }
      }
      function subscribe(listener) {
        listeners.add(listener);
        return () => listeners.delete(listener);
      }

      function ensureContext() {
        if (ctx) return ctx;
        const AudioCtor = win.AudioContext || win.webkitAudioContext;
        if (!AudioCtor) { stats.lastError = 'AudioContext 不可用'; return null; }
        try {
          ctx = new AudioCtor();
          gain = ctx.createGain();
          gain.gain.value = 0.9;
          gain.connect(ctx.destination);
          stats.sampleRate = ctx.sampleRate;
        } catch (error) {
          stats.lastError = String((error && error.message) || error);
          ctx = null;
          return null;
        }
        return ctx;
      }

      function decodeBase64(text) {
        const binary = win.atob(text);
        const bytes = new Uint8Array(binary.length);
        for (let index = 0; index < binary.length; index += 1) bytes[index] = binary.charCodeAt(index);
        return bytes;
      }

      async function enable() {
        const context = ensureContext();
        if (!context) { emit(); return false; }
        try { await context.resume(); } catch (error) { stats.lastError = String((error && error.message) || error); }
        enabled = context.state === 'running';
        nextTime = 0; // a (re)enabled player starts at "now", never at a stale cursor
        if (win.__UTB_TEST_HOOKS__ === true) win.__UTB_AUDIO_STATS__ = snapshot;
        emit();
        return enabled;
      }

      function disable() {
        enabled = false;
        nextTime = 0;
        try { if (ctx) ctx.suspend(); } catch { /* ignore */ }
        emit();
      }

      function reset() {
        nextTime = 0;
        emit();
      }

      /** One `{type:'audio'}` message from the frame socket. */
      function push(message) {
        if (!message) return;
        stats.lastPacketAt = Date.now();
        if (message.state === 'reset') {
          stats.resets += 1;
          reset();
          return;
        }
        stats.packets += 1;
        if (!enabled) return; // counting still happens so the panel can show "sound available"
        const context = ensureContext();
        if (!context) return;
        if (context.state === 'suspended') { try { context.resume(); } catch { /* ignore */ } }
        const rate = Number(message.rate) > 0 ? Number(message.rate) : 24000;
        const channels = Number(message.channels) > 0 ? Math.min(2, Number(message.channels)) : 1;
        if (typeof message.data !== 'string' || message.data.length === 0) return;
        let bytes;
        try { bytes = decodeBase64(message.data); } catch (error) {
          stats.decodeErrors += 1;
          stats.lastError = 'base64: ' + String((error && error.message) || error);
          return;
        }
        const samples = Math.floor(bytes.length / 2 / channels);
        if (samples <= 0) { stats.decodeErrors += 1; return; }
        const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
        let buffer;
        try {
          buffer = context.createBuffer(channels, samples, rate);
          for (let channel = 0; channel < channels; channel += 1) {
            const target = buffer.getChannelData(channel);
            for (let index = 0; index < samples; index += 1) {
              target[index] = view.getInt16((index * channels + channel) * 2, true) / 32768;
            }
          }
        } catch (error) {
          stats.decodeErrors += 1;
          stats.lastError = 'buffer: ' + String((error && error.message) || error);
          return;
        }
        const source = context.createBufferSource();
        source.buffer = buffer;
        source.connect(gain);
        const now = context.currentTime;
        // Start with a cushion; recover (drop the backlog) when the player fell too far behind.
        if (!(nextTime > now + 0.02) || nextTime > now + 1.2) nextTime = now + 0.1;
        try { source.start(nextTime); } catch { stats.dropped += 1; return; }
        nextTime += samples / rate;
        stats.played += 1;
        stats.bytes += bytes.length;
      }

      function close() {
        enabled = false;
        nextTime = 0;
        try { if (ctx) ctx.close(); } catch { /* ignore */ }
        ctx = null;
        gain = null;
        listeners.clear();
      }

      return { enable, disable, push, reset, close, subscribe, snapshot, get enabled() { return enabled; } };
    }
