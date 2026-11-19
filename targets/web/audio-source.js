/**
 * Host-side store for the Web target environment's page audio.
 *
 * `targets/web/audio-tap.js` runs inside the page and calls a CDP binding with one PCM packet at
 * a time; the Runtime validates that packet and hands it here. This module stays
 * transport-agnostic like `frame-source.js`: it owns the format/config, a short ring of recent
 * packets, the subscriber list and the counters. The frame pusher reads it; the panel is the only
 * consumer.
 *
 * Unlike video frames, audio packets are NOT last-writer-wins: every packet is one slice of a
 * continuous timeline, so subscribers receive each accepted packet exactly once and a slow
 * consumer loses packets instead of delaying them.
 *
 * Packets stay base64 on this path. The page already encoded them and the panel decodes them, so
 * the Host validates the payload (length/charset/sequence) without a decode+re-encode round trip
 * per packet.
 */
import { randomUUID } from 'node:crypto';

/** Format the tap produces; also the fallback advertised when no packet has arrived yet. */
export const AUDIO_FORMAT = Object.freeze({
  encoding: 's16le',
  rate: 24000,
  channels: 1,
});

/** Largest accepted base64 payload (a 85 ms mono 24 kHz s16 packet is ~5.5 KB). */
export const AUDIO_MAX_PAYLOAD_CHARS = 96 * 1024;

const BASE64 = /^[A-Za-z0-9+/]+={0,2}$/;

function base64Bytes(text) {
  const padding = text.endsWith('==') ? 2 : text.endsWith('=') ? 1 : 0;
  return Math.floor((text.length * 3) / 4) - padding;
}

/** A single PCM packet as the panel receives it. */
function normalizePacket(input) {
  if (!input || typeof input !== 'object') return null;
  const data = input.data;
  if (typeof data !== 'string' || data.length === 0 || data.length > AUDIO_MAX_PAYLOAD_CHARS) return null;
  if (!BASE64.test(data)) return null;
  const rate = Number(input.rate);
  const channels = Number(input.channels);
  const seq = Number(input.seq);
  if (!Number.isFinite(rate) || rate < 8000 || rate > 192000) return null;
  if (!Number.isFinite(channels) || channels < 1 || channels > 2) return null;
  if (!Number.isFinite(seq) || seq <= 0) return null;
  const normalizedRate = Math.floor(rate);
  const normalizedChannels = Math.floor(channels);
  const bytes = base64Bytes(data);
  if (bytes < 2) return null;
  return {
    seq: Math.floor(seq),
    rate: normalizedRate,
    channels: normalizedChannels,
    encoding: 's16le',
    data,
    bytes,
    samples: Math.floor(bytes / 2 / normalizedChannels),
    atMs: Number.isFinite(Number(input.atMs)) && Number(input.atMs) > 0 ? Math.round(Number(input.atMs)) : 0,
  };
}

export class AudioSource {
  /**
   * @param {{now?: () => number, maxChunks?: number, id?: string}} [options]
   */
  constructor({ now = Date.now, maxChunks = 8, id } = {}) {
    this.now = now;
    this.id = typeof id === 'string' && id.length > 0 ? id : randomUUID();
    this.maxChunks = Number.isFinite(maxChunks) ? Math.max(1, Math.floor(maxChunks)) : 8;
    this.subscribers = new Set();
    this.chunks = [];
    this.format = null;
    this.lastSeq = 0;
    this.lastAtMs = 0;
    this.receivedAt = 0;
    this.counters = { accepted: 0, dropped: 0, bytes: 0, error: 0, resets: 0 };
  }

  get live() {
    return this.format !== null;
  }

  /**
   * Accept one PCM packet straight from the page's binding payload (`{t:'a', seq, rate, ch,
   * enc, at, data}`). Anything malformed is counted and dropped.
   * @returns {object|null} the stored packet, or null when it was rejected/stale
   */
  accept(input) {
    const packet = normalizePacket({
      seq: input && input.seq,
      rate: input && input.rate,
      channels: input && (input.channels ?? input.ch),
      data: input && input.data,
      atMs: input && (input.atMs ?? input.at),
    });
    if (packet === null) {
      this.counters.error += 1;
      return null;
    }
    if (packet.seq <= this.lastSeq) {
      // Replayed or out-of-order packet: the panel timeline is strictly increasing.
      this.counters.dropped += 1;
      return null;
    }
    let formatChanged = false;
    if (this.format === null) {
      formatChanged = true;
    } else if (this.format.rate !== packet.rate || this.format.channels !== packet.channels) {
      formatChanged = true;
    }
    this.format = { encoding: packet.encoding, rate: packet.rate, channels: packet.channels };
    const stored = {
      ...packet,
      receivedAt: this.now(),
      sourceId: this.id,
      formatChanged,
      kind: 'audio',
    };
    this.lastSeq = packet.seq;
    this.lastAtMs = packet.atMs;
    this.receivedAt = stored.receivedAt;
    this.counters.accepted += 1;
    this.counters.bytes += packet.bytes;
    this.chunks.push(stored);
    while (this.chunks.length > this.maxChunks) this.chunks.shift();
    for (const listener of this.subscribers) {
      try { listener(stored); } catch { /* a bad consumer must not break capture */ }
    }
    return stored;
  }

  /** True when the newest packet is recent enough to call the stream live. */
  isFresh(staleMs = 2000) {
    return this.receivedAt > 0 && this.now() - this.receivedAt <= staleMs;
  }

  /** Recent packets, oldest first (a late subscriber can warm up without waiting). */
  recent() {
    return this.chunks.slice();
  }

  /** @param {(packet: object) => void} listener @returns {() => void} unsubscribe */
  subscribe(listener) {
    this.subscribers.add(listener);
    return () => this.subscribers.delete(listener);
  }

  /** A new document (or a stopped page) invalidates the previous timeline. */
  reset(reason = 'navigation') {
    const hadAudio = this.format !== null || this.chunks.length > 0;
    this.chunks.length = 0;
    this.format = null;
    this.lastSeq = 0;
    this.lastAtMs = 0;
    this.receivedAt = 0;
    this.counters.resets += 1;
    if (hadAudio) {
      for (const listener of this.subscribers) {
        try { listener({ type: 'reset', reason, kind: 'audio-reset' }); } catch { /* ignore */ }
      }
    }
  }

  /** Public projection: format + counters only, never PCM payload bytes. */
  metrics() {
    return {
      live: this.live,
      fresh: this.isFresh(),
      format: this.format === null ? null : { ...this.format },
      lastSeq: this.lastSeq,
      lastAtMs: this.lastAtMs,
      receivedAt: this.receivedAt,
      buffered: this.chunks.length,
      ...this.counters,
    };
  }
}
