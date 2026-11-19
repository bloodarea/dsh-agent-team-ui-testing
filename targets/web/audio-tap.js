/**
 * Page-side audio tap for the Web target environment.
 *
 * The debug panel preview has to carry the page's own sound. Neither `Page.startScreencast`
 * (JPEG frames only) nor any other CDP domain exposes tab audio, so the only host-independent
 * way to hear a page is to tap its audio graph from inside the page and ship raw PCM to the
 * panel:
 *
 *   - Web Audio output: `AudioNode.prototype.connect` is wrapped so every node that is wired
 *     into a context's `destination` is also wired into a per-context
 *     `MediaStreamAudioDestinationNode`;
 *   - media elements (`<audio>`/`<video>`): `HTMLMediaElement.prototype.play` plus a capturing
 *     `play` listener hand the element's `captureStream()` audio track to the same mixer;
 *   - the mixer is a `ScriptProcessorNode` in one private `AudioContext`, connected through a
 *     zero-gain node so the tap itself is inaudible on the host.
 *
 * The tap is deliberately passive: every hook falls through to the original implementation, any
 * internal failure is swallowed, and nothing is injected into page-visible state beyond a single
 * `window.__dshUiTestingAudioStats()` diagnostics accessor.
 *
 * Chromium keeps the page audio graph running even under `--mute-audio` (that flag only mutes the
 * output device), so the tap works in headless AND headed mode. It does need an
 * `--autoplay-policy=no-user-gesture-required` browser or a real user gesture, because a private
 * `AudioContext` starts suspended otherwise.
 *
 * Wire format page → Host: `window[AUDIO_BINDING](JSON.stringify({t:'a', seq, rate, ch, enc, at,
 * data:<base64 s16le>}))`. The Host decodes it and forwards to the panel; the constants below are
 * mirrored literally inside the injected source string and must stay in sync.
 */

/** `Runtime.addBinding` name the injected script calls with each audio packet. */
export const AUDIO_BINDING = '__dshUiTestingAudio';
/** Output sample rate of the tap (mono). 24 kHz keeps speech/music usable at ~48 KB/s. */
export const AUDIO_SAMPLE_RATE = 24000;
/** Output channel count of the tap. */
export const AUDIO_CHANNELS = 1;
/** Sample encoding of the base64 payload. */
export const AUDIO_ENCODING = 's16le';
/** Largest accepted packet (base64 payload length) before the Host refuses it. */
export const AUDIO_MAX_PAYLOAD_BYTES = 96 * 1024;
/** How many recent packets the Host keeps for late subscribers. */
export const AUDIO_BUFFER_CHUNKS = 8;

/**
 * The injected source. Runs in the page's main world at document start (and once against the
 * already-loaded document), so it sees the page's own `AudioContext`/media elements.
 */
export const AUDIO_TAP_SOURCE = `(function () {
  'use strict';
  // Top document only. The injected script also runs in every child frame, and two taps would
  // interleave two independent sequence numbers into one panel timeline. Audio that only exists
  // inside an iframe is therefore not captured (documented limitation).
  try { if (window.top !== window) return; } catch (e) { return; }
  if (window.__dshUiTestingAudioTap === true) return;
  window.__dshUiTestingAudioTap = true;
  var BINDING = '${AUDIO_BINDING}';
  var OUT_RATE = ${AUDIO_SAMPLE_RATE};
  var FRAME_SAMPLES = 4096;
  // Digital silence is dropped so an idle page does not stream 48 KB/s of zeroes forever.
  // The threshold is far below anything audible (24 kHz s16 LSB = 3e-5).
  var SILENCE_RMS = 0.0004;
  var ctx = null;
  var proc = null;
  var seq = 0;
  var sentFrames = 0;
  var sentBytes = 0;
  var lastError = null;
  var tappedNodes = new WeakSet();
  var tappedContexts = new WeakMap();
  var tappedMedia = new WeakSet();
  var originalConnect = null;

  function binding() {
    try { return typeof window[BINDING] === 'function' ? window[BINDING] : null; } catch (e) { return null; }
  }

  function ensureCapture() {
    if (ctx) return ctx;
    var AudioCtor = window.AudioContext || window.webkitAudioContext;
    if (!AudioCtor) return null;
    try { ctx = new AudioCtor(); } catch (e) { ctx = null; return null; }
    try {
      // ScriptProcessor is the one pull-based tap that needs no external worklet module URL.
      proc = ctx.createScriptProcessor(FRAME_SAMPLES, 1, 1);
      var silent = ctx.createGain();
      silent.gain.value = 0;
      silent.connect(ctx.destination);
      proc.connect(silent);
      proc.onaudioprocess = function (event) {
        try { emit(event.inputBuffer.getChannelData(0)); } catch (e) { lastError = String(e && e.message || e); }
      };
      if (ctx.state === 'suspended') {
        try { ctx.resume().catch(function () {}); } catch (e) { /* policy-blocked: no sound yet */ }
      }
    } catch (e) {
      lastError = String(e && e.message || e);
      ctx = null;
      return null;
    }
    return ctx;
  }

  function resample(samples) {
    var rate = (ctx && ctx.sampleRate) || 48000;
    var ratio = rate / OUT_RATE;
    var count = Math.max(1, Math.round(samples.length / ratio));
    var out = new Int16Array(count);
    var sum = 0;
    var i;
    var j;
    if (ratio >= 1) {
      // Downsample: average each source window (avoids the aliasing of plain decimation).
      for (i = 0; i < count; i += 1) {
        var start = Math.floor(i * ratio);
        var end = Math.min(samples.length, Math.max(start + 1, Math.floor((i + 1) * ratio)));
        var acc = 0;
        for (j = start; j < end; j += 1) acc += samples[j];
        var value = acc / (end - start);
        sum += value * value;
        out[i] = value <= -1 ? -32768 : value >= 1 ? 32767 : (value * 32767) | 0;
      }
    } else {
      // Upsample (only on exotic low-rate devices): linear interpolation.
      var step = (samples.length - 1) / Math.max(1, count - 1);
      for (i = 0; i < count; i += 1) {
        var pos = i * step;
        var base = Math.floor(pos);
        var next = Math.min(samples.length - 1, base + 1);
        var value2 = samples[base] + (samples[next] - samples[base]) * (pos - base);
        sum += value2 * value2;
        out[i] = value2 <= -1 ? -32768 : value2 >= 1 ? 32767 : (value2 * 32767) | 0;
      }
    }
    if (Math.sqrt(sum / count) < SILENCE_RMS) return null;
    return out;
  }

  function toBase64(pcm) {
    var bytes = new Uint8Array(pcm.buffer, pcm.byteOffset, pcm.byteLength);
    var text = '';
    var CHUNK = 0x8000;
    for (var i = 0; i < bytes.length; i += CHUNK) {
      text += String.fromCharCode.apply(null, bytes.subarray(i, i + CHUNK));
    }
    return btoa(text);
  }

  function emit(samples) {
    var send = binding();
    if (!send) return;
    var pcm = resample(samples);
    if (pcm === null) return;
    var base64;
    try { base64 = toBase64(pcm); } catch (e) { lastError = String(e && e.message || e); return; }
    seq += 1;
    sentFrames += 1;
    sentBytes += base64.length;
    try {
      send(JSON.stringify({ t: 'a', seq: seq, rate: OUT_RATE, ch: 1, enc: 's16le', at: Date.now(), data: base64 }));
    } catch (e) { lastError = String(e && e.message || e); }
  }

  function bridge(stream) {
    var capture = ensureCapture();
    if (!capture || !stream) return;
    try {
      var source = capture.createMediaStreamSource(stream);
      source.connect(proc);
    } catch (e) { lastError = String(e && e.message || e); }
  }

  function tapContext(audioCtx) {
    var known = tappedContexts.get(audioCtx);
    if (known) return known;
    var dest = null;
    try { dest = audioCtx.createMediaStreamDestination(); } catch (e) { return null; }
    var entry = { dest: dest };
    tappedContexts.set(audioCtx, entry);
    if (audioCtx.state === 'suspended') {
      try { audioCtx.resume().catch(function () {}); } catch (e) { /* page policy */ }
    }
    // Bridge this context's tap stream into the private mixer exactly once.
    bridge(dest.stream);
    return entry;
  }

  function tapNode(node, audioCtx) {
    if (!node || !audioCtx || tappedNodes.has(node)) return;
    var entry = tapContext(audioCtx);
    if (!entry) return;
    tappedNodes.add(node);
    try { originalConnect.call(node, entry.dest); } catch (e) { /* never break page audio */ }
  }

  /**
   * captureStream() right after play() can hand back a video-only stream: Chromium only adds the
   * audio track once the media has decoded audio. So the stream is captured once, retried on the
   * element's own media events, and given up after a bounded number of ticks.
   */
  function bridgeMedia(element) {
    if (!element || tappedMedia.has(element)) return true;
    if (typeof element.captureStream !== 'function') return true;
    var stream = element.__dshUiTestingAudioStream;
    if (!stream) {
      try { stream = element.captureStream(); } catch (e) { tappedMedia.add(element); return true; }
      element.__dshUiTestingAudioStream = stream;
    }
    var tracks = stream.getAudioTracks ? stream.getAudioTracks() : [];
    if (tracks.length === 0) return false;
    tappedMedia.add(element);
    bridge(stream);
    return true;
  }

  function armMedia(element) {
    if (!element || element.__dshUiTestingAudioArmed) return;
    element.__dshUiTestingAudioArmed = true;
    var tries = 0;
    var done = false;
    var cleanup = function () {
      try {
        element.removeEventListener('loadedmetadata', retry);
        element.removeEventListener('loadeddata', retry);
        element.removeEventListener('canplay', retry);
        element.removeEventListener('playing', retry);
      } catch (e) { /* ignore */ }
      element.__dshUiTestingAudioTimer = null;
    };
    var retry = function () {
      if (done) return;
      tries += 1;
      if (bridgeMedia(element) || tries > 40) { done = true; cleanup(); return; }
      if (element.__dshUiTestingAudioTimer === null || element.__dshUiTestingAudioTimer === undefined) {
        element.__dshUiTestingAudioTimer = setTimeout(function () {
          element.__dshUiTestingAudioTimer = null;
          retry();
        }, 250);
      }
    };
    try {
      element.addEventListener('loadedmetadata', retry);
      element.addEventListener('loadeddata', retry);
      element.addEventListener('canplay', retry);
      element.addEventListener('playing', retry);
    } catch (e) { /* ignore */ }
    retry();
  }

  function tapMedia(element) {
    if (!element) return;
    armMedia(element);
    bridgeMedia(element);
  }

  try {
    originalConnect = AudioNode.prototype.connect;
    AudioNode.prototype.connect = function (destination) {
      try {
        if (destination && typeof AudioDestinationNode !== 'undefined' && destination instanceof AudioDestinationNode) {
          tapNode(this, destination.context);
        }
      } catch (e) { /* passthrough */ }
      return originalConnect.apply(this, arguments);
    };
  } catch (e) { lastError = String(e && e.message || e); }

  try {
    var originalPlay = HTMLMediaElement.prototype.play;
    HTMLMediaElement.prototype.play = function () {
      try { tapMedia(this); } catch (e) { /* passthrough */ }
      return originalPlay.apply(this, arguments);
    };
  } catch (e) { lastError = String(e && e.message || e); }

  try {
    // Autoplay or a src change starts media without going through the element's own play().
    document.addEventListener('play', function (event) {
      var target = event.target;
      if (target && (target.tagName === 'AUDIO' || target.tagName === 'VIDEO')) tapMedia(target);
    }, true);
  } catch (e) { /* ignore */ }

  try {
    var scan = function () {
      var list = document.querySelectorAll('audio,video');
      for (var i = 0; i < list.length; i += 1) {
        if (!list[i].paused) tapMedia(list[i]);
      }
    };
    if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', scan, true);
    else scan();
  } catch (e) { /* ignore */ }

  window.__dshUiTestingAudioStats = function () {
    return {
      installed: true,
      seq: seq,
      frames: sentFrames,
      bytes: sentBytes,
      sampleRate: ctx ? ctx.sampleRate : null,
      outRate: OUT_RATE,
      contextState: ctx ? ctx.state : null,
      error: lastError,
    };
  };
})();`;
