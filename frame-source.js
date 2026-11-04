/**
 * Transport-agnostic frame store for the T1 preview.
 *
 * The CDP screencast is event-driven: Chromium emits a JPEG frame when the page damages.
 * This class keeps only the newest frame plus its metadata, so a slow consumer can never
 * build a latency backlog (last-writer-wins). Transports (HTTP polling, same-origin
 * WebSocket push) read `latest()` or `subscribe()`; neither capture nor UI semantics live
 * here.
 *
 * Timestamps: `capturedAt` / `receivedAt` are epoch milliseconds. CDP reports
 * `screencastFrameMetadata.timestamp` in epoch seconds, so `accept()` normalizes it.
 */

const INTERVAL_SAMPLES = 12;

function toPositiveInt(value) {
  const number = Number(value);
  return Number.isFinite(number) && number > 0 ? Math.round(number) : 0;
}

/**
 * Capture-time top-level scroll (docs/viewport-control.md): a finite non-negative CSS px value;
 * 0 is legal. Missing/invalid metadata is stored as 0, never as NaN/undefined (the value is lossless
 * JSON on both the HTTP `/frame` payload and the WS binary header).
 */
function toScrollOffset(value) {
  const number = Number(value);
  return Number.isFinite(number) && number >= 0 ? number : 0;
}

function normalizeCapturedAt(value, fallback) {
  const number = Number(value);
  if (!Number.isFinite(number) || number <= 0) return fallback;
  // CDP uses seconds (epoch); tolerate callers that already pass milliseconds.
  return number < 1e12 ? Math.round(number * 1000) : Math.round(number);
}

export class FrameSource {
  constructor({ now = Date.now } = {}) {
    this.now = now;
    this.seq = 0;
    this.epoch = 0;
    this.url = '';
    this.stopped = false;
    this.latestFrame = undefined;
    this.subscribers = new Set();
    this.captured = 0;
    this.cachedOnly = 0;
    this.lastCapturedAt = 0;
    this.intervals = [];
  }

  /**
   * Accept one captured JPEG frame.
   * @param {{data: string, width?: number, height?: number, pageWidth?: number, pageHeight?: number,
   *          scrollX?: number, scrollY?: number, capturedAt?: number, format?: string}} input
   * @returns {object} the stored frame (the same object is handed to subscribers).
   */
  accept(input) {
    this.stopped = false;
    const receivedAt = this.now();
    const capturedAt = normalizeCapturedAt(input.capturedAt, receivedAt);
    const frame = {
      seq: this.seq + 1,
      epoch: this.epoch,
      data: String(input.data || ''),
      format: input.format || 'jpeg',
      width: toPositiveInt(input.width),
      height: toPositiveInt(input.height),
      pageWidth: toPositiveInt(input.pageWidth) || toPositiveInt(input.width),
      pageHeight: toPositiveInt(input.pageHeight) || toPositiveInt(input.height),
      // The page's top-level scroll when this frame was captured; the panel uses it to place the
      // frame in canvas space (docs/viewport-control.md).
      scrollX: toScrollOffset(input.scrollX),
      scrollY: toScrollOffset(input.scrollY),
      capturedAt,
      receivedAt,
    };
    this.seq = frame.seq;
    this.captured += 1;
    this.latestFrame = frame;

    if (this.lastCapturedAt > 0) {
      const delta = capturedAt - this.lastCapturedAt;
      if (delta > 0 && delta < 5000) {
        this.intervals.push(delta);
        if (this.intervals.length > INTERVAL_SAMPLES) this.intervals.shift();
      }
    }
    this.lastCapturedAt = capturedAt;

    if (this.subscribers.size === 0) this.cachedOnly += 1;
    else for (const listener of this.subscribers) {
      try { listener(frame); } catch { /* a bad transport must not break capture */ }
    }
    return frame;
  }

  /** A main-frame navigation starts a new epoch; transports use it to discard stale frames. */
  markNavigation(url) {
    this.epoch += 1;
    this.url = String(url || '');
  }

  latest() {
    return this.latestFrame;
  }

  /** @param {(frame: object) => void} listener @returns {() => void} unsubscribe */
  subscribe(listener) {
    this.subscribers.add(listener);
    return () => this.subscribers.delete(listener);
  }

  /** Drop the cached frame and all subscribers (used by /close and plugin dispose). */
  stop() {
    this.stopped = true;
    // A restarted stream must be distinguishable from stale frames of the previous epoch.
    this.epoch += 1;
    this.latestFrame = undefined;
    this.subscribers.clear();
    this.seq = 0;
    this.captured = 0;
    this.cachedOnly = 0;
    this.lastCapturedAt = 0;
    this.intervals.length = 0;
  }

  /**
   * Measured capture statistics (from CDP frame timestamps), never derived from a polling
   * interval. `captureFps` is 0 until at least two fresh frames were observed.
   */
  metrics() {
    let captureFps = 0;
    let captureIntervalMs = 0;
    if (this.intervals.length > 0) {
      const total = this.intervals.reduce((sum, value) => sum + value, 0);
      captureIntervalMs = Math.round((total / this.intervals.length) * 10) / 10;
      captureFps = captureIntervalMs > 0 ? Math.round((1000 / captureIntervalMs) * 10) / 10 : 0;
    }
    return {
      seq: this.seq,
      epoch: this.epoch,
      url: this.url,
      captured: this.captured,
      cachedOnly: this.cachedOnly,
      subscribers: this.subscribers.size,
      captureFps,
      captureIntervalMs,
      measured: { captureFps: this.intervals.length > 0, captureIntervalMs: this.intervals.length > 0 },
      lastFrame: this.latestFrame === undefined ? null : {
        seq: this.latestFrame.seq,
        epoch: this.latestFrame.epoch,
        capturedAt: this.latestFrame.capturedAt,
        receivedAt: this.latestFrame.receivedAt,
        width: this.latestFrame.width,
        height: this.latestFrame.height,
        format: this.latestFrame.format,
      },
    };
  }
}
