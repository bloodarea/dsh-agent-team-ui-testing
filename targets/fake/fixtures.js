/**
 * Deterministic, non-Web fixtures for the test-only fake environment.
 *
 * Everything here is pure and dependency-free (node: builtins only):
 *  - stable JSON (sorted keys) and sha256 helpers,
 *  - a minimal PNG encoder built by hand (zlib deflate for IDAT, own CRC32),
 *  - deterministic id helpers.
 *
 * No browser, no network, no repository writes.
 */

import { createHash } from 'node:crypto';
import { deflateSync } from 'node:zlib';

/** Lowercase sha256 hex digest of bytes/strings. */
export function sha256Hex(value) {
  return createHash('sha256').update(value).digest('hex');
}

/**
 * Stable JSON: object keys are sorted, undefined-valued keys are skipped.
 * Same input -> same string, independent of property insertion order.
 */
export function canonicalJson(value) {
  if (value === null || typeof value !== 'object') {
    const encoded = JSON.stringify(value);
    return encoded === undefined ? 'null' : encoded;
  }
  if (Array.isArray(value)) {
    return `[${value.map((item) => canonicalJson(item)).join(',')}]`;
  }
  const parts = [];
  for (const key of Object.keys(value).sort()) {
    if (value[key] === undefined) continue;
    parts.push(`${JSON.stringify(key)}:${canonicalJson(value[key])}`);
  }
  return `{${parts.join(',')}}`;
}

/** Deterministic id: `${seed}:${parts.join(':')}`. */
export function fakeId(seed, ...parts) {
  return [seed, ...parts.map((part) => String(part))].join(':');
}

/** Deterministic short digest id (16 hex chars) derived from seed + parts. */
export function fakeDigest(seed, ...parts) {
  return sha256Hex(Buffer.from([seed, ...parts.map((part) => String(part))].join('\u0000'), 'utf8')).slice(0, 16);
}

// ---------------------------------------------------------------------------
// Minimal PNG encoder (RGBA, bit depth 8, no interlace)
// ---------------------------------------------------------------------------

const CRC_TABLE = (() => {
  const table = new Uint32Array(256);
  for (let n = 0; n < 256; n += 1) {
    let c = n;
    for (let k = 0; k < 8; k += 1) {
      c = (c & 1) ? (0xedb88320 ^ (c >>> 1)) : (c >>> 1);
    }
    table[n] = c >>> 0;
  }
  return table;
})();

/** CRC32 over a byte buffer (PNG chunk CRC, IEEE polynomial). */
export function crc32(bytes) {
  let crc = 0xffffffff;
  for (let index = 0; index < bytes.length; index += 1) {
    crc = CRC_TABLE[(crc ^ bytes[index]) & 0xff] ^ (crc >>> 8);
  }
  return (crc ^ 0xffffffff) >>> 0;
}

/** One PNG chunk: length, type, data, CRC(type + data). */
export function pngChunk(type, data) {
  const typeBytes = Buffer.from(type, 'ascii');
  const body = Buffer.concat([typeBytes, data]);
  const chunk = Buffer.alloc(12 + data.length);
  chunk.writeUInt32BE(data.length, 0);
  typeBytes.copy(chunk, 4);
  data.copy(chunk, 8);
  chunk.writeUInt32BE(crc32(body), 8 + data.length);
  return chunk;
}

/** Default 2x2 RGBA pixels (opaque red / green / blue / white). */
export const DEFAULT_PNG_PIXELS = Object.freeze([
  255, 0, 0, 255,
  0, 255, 0, 255,
  0, 0, 255, 255,
  255, 255, 255, 255,
]);

/**
 * Build a deterministic, valid PNG.
 * @param {{width?:number, height?:number, pixels?:number[]|Uint8Array}} [options]
 * @returns {{bytes:Buffer, width:number, height:number, rgba:Buffer, sha256:string}}
 */
export function createDeterministicPng({ width = 2, height = 2, pixels = DEFAULT_PNG_PIXELS } = {}) {
  if (!Number.isInteger(width) || width < 1) throw new TypeError('createDeterministicPng: width must be an integer >= 1');
  if (!Number.isInteger(height) || height < 1) throw new TypeError('createDeterministicPng: height must be an integer >= 1');
  const pixelBytes = width * height * 4;
  const rgba = Buffer.alloc(pixelBytes);
  if (pixels instanceof Uint8Array) {
    rgba.set(pixels.subarray(0, Math.min(pixels.length, pixelBytes)));
  } else {
    for (let index = 0; index < Math.min(pixels.length, pixelBytes); index += 1) rgba[index] = pixels[index] & 0xff;
  }

  const signature = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);
  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(width, 0);
  ihdr.writeUInt32BE(height, 4);
  ihdr[8] = 8; // bit depth
  ihdr[9] = 6; // color type: RGBA
  ihdr[10] = 0; // compression
  ihdr[11] = 0; // filter
  ihdr[12] = 0; // interlace

  const stride = width * 4;
  const raw = Buffer.alloc((stride + 1) * height);
  for (let row = 0; row < height; row += 1) {
    const offset = row * (stride + 1);
    raw[offset] = 0; // filter type: none
    rgba.copy(raw, offset + 1, row * stride, (row + 1) * stride);
  }
  const idat = deflateSync(raw, { level: 9 });

  const bytes = Buffer.concat([
    signature,
    pngChunk('IHDR', ihdr),
    pngChunk('IDAT', idat),
    pngChunk('IEND', Buffer.alloc(0)),
  ]);
  return { bytes, width, height, rgba, sha256: sha256Hex(bytes) };
}

/**
 * Parse enough of a PNG to verify structure: signature, IHDR dimensions and
 * every chunk CRC. Used by tests as a minimal structural check.
 * @param {Buffer|Uint8Array} bytes
 */
export function inspectPng(bytes) {
  const buffer = Buffer.isBuffer(bytes) ? bytes : Buffer.from(bytes);
  const signature = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);
  const validSignature = buffer.length >= 8 && buffer.subarray(0, 8).equals(signature);
  const chunks = [];
  let offset = 8;
  while (offset + 12 <= buffer.length) {
    const length = buffer.readUInt32BE(offset);
    const type = buffer.subarray(offset + 4, offset + 8).toString('ascii');
    const dataStart = offset + 8;
    const dataEnd = dataStart + length;
    if (dataEnd + 4 > buffer.length) break;
    const expected = buffer.readUInt32BE(dataEnd);
    const actual = crc32(buffer.subarray(offset + 4, dataEnd));
    chunks.push({ type, length, crcOk: expected === actual, data: buffer.subarray(dataStart, dataEnd) });
    offset = dataEnd + 4;
    if (type === 'IEND') break;
  }
  const ihdr = chunks.find((chunk) => chunk.type === 'IHDR');
  const width = ihdr ? ihdr.data.readUInt32BE(0) : 0;
  const height = ihdr ? ihdr.data.readUInt32BE(4) : 0;
  const bitDepth = ihdr ? ihdr.data[8] : 0;
  const colorType = ihdr ? ihdr.data[9] : 0;
  return {
    validSignature,
    chunks,
    width,
    height,
    bitDepth,
    colorType,
    crcOk: chunks.length > 0 && chunks.every((chunk) => chunk.crcOk),
    idat: chunks.filter((chunk) => chunk.type === 'IDAT').map((chunk) => chunk.data),
  };
}
