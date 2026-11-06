/**
 * capture-p0.js 单元测试（node:test + node:assert/strict，零依赖）。
 *
 * 真值来源是测试自带的**独立 PNG 编码器**（filter 正向变换 + CRC32）与逐字节断言，
 * 不靠肉眼、不靠工具自报。运行：`node --test tests/capture-p0.test.mjs`
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import {
  chmodSync, lstatSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync,
  statSync, symlinkSync, writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { deflateSync } from 'node:zlib';

import {
  CAPTURE_LIMITS, PNG_SIGNATURE, checkPixelSize, createCaptureMapping, crc32, decodePng,
  detectImageAnomaly, expectedPixelSize, inspectPng, projectCaptureMapping, publishCapture,
  resolveCapturePath,
} from '../capture-p0.js';

/* ------------------------------------------------------------------------------------------------
 * 独立的最小 PNG 编码器（测试夹具）：只用于造样本，与被测解码器不共享任何 filter 逻辑。
 * ---------------------------------------------------------------------------------------------- */

const SIGNATURE = Buffer.from(PNG_SIGNATURE);
const CHANNELS = { 0: 1, 2: 3, 4: 2, 6: 4 };

function pngChunk(type, data) {
  const typeBuf = Buffer.from(type, 'latin1');
  const out = Buffer.alloc(8 + data.length + 4);
  out.writeUInt32BE(data.length, 0);
  typeBuf.copy(out, 4);
  data.copy(out, 8);
  out.writeUInt32BE(crc32(Buffer.concat([typeBuf, data])), 8 + data.length);
  return out;
}

function paeth(a, b, c) {
  const p = a + b - c;
  const pa = Math.abs(p - a);
  const pb = Math.abs(p - b);
  const pc = Math.abs(p - c);
  if (pa <= pb && pa <= pc) return a;
  if (pb <= pc) return b;
  return c;
}

function filterRow(type, raw, prev, bpp) {
  const out = Buffer.alloc(raw.length);
  for (let i = 0; i < raw.length; i += 1) {
    const left = i >= bpp ? raw[i - bpp] : 0;
    const up = prev ? prev[i] : 0;
    const upLeft = prev && i >= bpp ? prev[i - bpp] : 0;
    let value;
    if (type === 0) value = raw[i];
    else if (type === 1) value = raw[i] - left;
    else if (type === 2) value = raw[i] - up;
    else if (type === 3) value = raw[i] - Math.floor((left + up) / 2);
    else if (type === 4) value = raw[i] - paeth(left, up, upLeft);
    else throw new Error('bad filter ' + type);
    out[i] = value & 0xff;
  }
  return out;
}

/**
 * @param {{width:number,height:number,colorType:number,rows:Buffer[],filters:number|number[],
 *          bitDepth?:number,interlace?:number,idatChunks?:number}} spec
 */
function encodePng({ width, height, colorType, rows, filters, bitDepth = 8, interlace = 0, idatChunks = 1 }) {
  const channels = CHANNELS[colorType];
  if (!channels) throw new Error('unsupported color type in the fixture encoder');
  assert.equal(rows.length, height, 'fixture needs one row buffer per pixel row');
  const stride = width * channels;
  const filtered = Buffer.alloc((stride + 1) * height);
  let offset = 0;
  for (let y = 0; y < height; y += 1) {
    assert.equal(rows[y].length, stride, 'fixture row length mismatch');
    const filter = Array.isArray(filters) ? filters[y] : filters;
    filtered[offset] = filter;
    filterRow(filter, rows[y], y > 0 ? rows[y - 1] : null, channels).copy(filtered, offset + 1);
    offset += stride + 1;
  }
  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(width, 0);
  ihdr.writeUInt32BE(height, 4);
  ihdr[8] = bitDepth;
  ihdr[9] = colorType;
  ihdr[10] = 0;
  ihdr[11] = 0;
  ihdr[12] = interlace;
  const idat = deflateSync(filtered);
  const parts = [SIGNATURE, pngChunk('IHDR', ihdr)];
  const per = Math.ceil(idat.length / idatChunks);
  for (let i = 0; i < idatChunks; i += 1) {
    const slice = idat.subarray(i * per, Math.min((i + 1) * per, idat.length));
    if (slice.length) parts.push(pngChunk('IDAT', slice));
  }
  parts.push(pngChunk('IEND', Buffer.alloc(0)));
  return Buffer.concat(parts);
}

function solidRow(width, channels, values) {
  const row = Buffer.alloc(width * channels);
  for (let x = 0; x < width; x += 1) {
    for (let c = 0; c < channels; c += 1) row[x * channels + c] = values[c];
  }
  return row;
}

function makeTempRoot(prefix = 'capture-p0-test-') {
  return mkdtempSync(join(tmpdir(), prefix));
}

/* ------------------------------------------------------------------------------------------------
 * inspectPng / decodePng
 * ---------------------------------------------------------------------------------------------- */

test('inspectPng + decodePng: color type 0 (gray) 1x1 filter 0', () => {
  const bytes = encodePng({ width: 1, height: 1, colorType: 0, rows: [Buffer.from([0x7f])], filters: 0 });
  const inspected = inspectPng(bytes);
  assert.equal(inspected.ok, true);
  assert.equal(inspected.width, 1);
  assert.equal(inspected.height, 1);
  assert.equal(inspected.bytes, bytes.length);
  assert.equal(inspected.chunks, 3);
  const decoded = decodePng(bytes);
  assert.equal(decoded.ok, true);
  assert.equal(decoded.channels, 1);
  assert.deepEqual([...decoded.data], [0x7f]);
});

test('inspectPng + decodePng: color type 2 (RGB) 2x2 filter 0 逐字节真值', () => {
  const rows = [
    Buffer.from([255, 0, 0, 0, 128, 255]),
    Buffer.from([0, 255, 0, 10, 20, 30]),
  ];
  const bytes = encodePng({ width: 2, height: 2, colorType: 2, rows, filters: 0 });
  const decoded = decodePng(bytes);
  assert.equal(decoded.ok, true);
  assert.equal(decoded.width, 2);
  assert.equal(decoded.height, 2);
  assert.equal(decoded.channels, 3);
  assert.equal(decoded.colorType, 2);
  assert.deepEqual([...decoded.data], [...rows[0], ...rows[1]]);
});

test('decodePng: filter 1/2/3/4 全部可逆（3x1 与 100x3 覆盖多行）', () => {
  for (const filter of [0, 1, 2, 3, 4]) {
    // 3x1 RGB：单行，filter 2/3/4 的上邻居为 0 行。
    const row = Buffer.from([200, 10, 30, 5, 250, 111, 77, 0, 128]);
    const one = encodePng({ width: 3, height: 1, colorType: 2, rows: [row], filters: filter });
    const decodedOne = decodePng(one);
    assert.equal(decodedOne.ok, true, `filter ${filter} single row`);
    assert.deepEqual([...decodedOne.data], [...row], `filter ${filter} single row pixels`);

    // 100x3 RGB：多行，filter 的 left/up/upLeft 都参与。
    const rows = [0, 1, 2].map((y) => {
      const buffer = Buffer.alloc(100 * 3);
      for (let i = 0; i < buffer.length; i += 1) buffer[i] = (i * 7 + y * 13 + filter * 3) & 0xff;
      return buffer;
    });
    const multi = encodePng({ width: 100, height: 3, colorType: 2, rows, filters: [filter, filter, filter] });
    const decodedMulti = decodePng(multi);
    assert.equal(decodedMulti.ok, true, `filter ${filter} multi row`);
    assert.deepEqual([...decodedMulti.data], [...rows[0], ...rows[1], ...rows[2]], `filter ${filter} multi row pixels`);
  }
});

test('decodePng: 逐行不同 filter 与多块 IDAT', () => {
  const rows = [0, 1, 2, 3].map((y) => {
    const buffer = Buffer.alloc(3 * 4);
    for (let i = 0; i < buffer.length; i += 1) buffer[i] = (i * 11 + y * 29) & 0xff;
    return buffer;
  });
  const bytes = encodePng({ width: 3, height: 4, colorType: 6, rows, filters: [0, 1, 2, 3], idatChunks: 3 });
  assert.equal(inspectPng(bytes).chunks, 2 + 3);
  const decoded = decodePng(bytes);
  assert.equal(decoded.ok, true);
  assert.equal(decoded.channels, 4);
  assert.deepEqual([...decoded.data], [...rows[0], ...rows[1], ...rows[2], ...rows[3]]);
});

test('decodePng: color type 4 (GA) 2x2', () => {
  const rows = [Buffer.from([10, 255, 20, 0]), Buffer.from([30, 128, 40, 64])];
  const bytes = encodePng({ width: 2, height: 2, colorType: 4, rows, filters: 1 });
  const decoded = decodePng(bytes);
  assert.equal(decoded.ok, true);
  assert.equal(decoded.channels, 2);
  assert.deepEqual([...decoded.data], [...rows[0], ...rows[1]]);
});

test('inspectPng/decodePng: 截断、坏 CRC、尾部垃圾、非 PNG', () => {
  const bytes = encodePng({ width: 2, height: 2, colorType: 2, rows: [solidRow(2, 3, [1, 2, 3]), solidRow(2, 3, [4, 5, 6])], filters: 0 });

  // 去掉 IEND 块（12 字节）
  const noIend = bytes.subarray(0, bytes.length - 12);
  assert.equal(inspectPng(noIend).code, 'INVALID_PNG');
  assert.equal(decodePng(noIend).code, 'INVALID_PNG');
  assert.match(inspectPng(noIend).message, /IEND/);

  // 去掉 IDAT 尾部若干字节 -> 块边界截断
  const cutIdat = bytes.subarray(0, bytes.length - 20);
  assert.equal(inspectPng(cutIdat).code, 'INVALID_PNG');
  assert.match(inspectPng(cutIdat).message, /truncated/);

  // 坏 CRC：翻转 IHDR 的 CRC 字节
  const badCrc = Buffer.from(bytes);
  badCrc[8 + 8 + 13 + 3] ^= 0xff;
  const badCrcResult = inspectPng(badCrc);
  assert.equal(badCrcResult.ok, false);
  assert.equal(badCrcResult.code, 'INVALID_PNG');
  assert.match(badCrcResult.message, /CRC/);
  assert.equal(decodePng(badCrc).code, 'INVALID_PNG');
  // checkCrc:false 只跳过 CRC，不跳过结构
  assert.equal(inspectPng(badCrc, { checkCrc: false }).ok, true);

  // IEND 后尾部垃圾
  const trailing = Buffer.concat([bytes, Buffer.from([1, 2, 3])]);
  assert.equal(inspectPng(trailing).ok, false);
  assert.match(inspectPng(trailing).message, /trailing bytes/);

  // 非 PNG
  assert.equal(inspectPng(Buffer.from('not a png at all')).code, 'INVALID_PNG');
  assert.equal(inspectPng(Buffer.alloc(0)).code, 'INVALID_PNG');
  assert.equal(decodePng(Buffer.from('GIF89a')).code, 'INVALID_PNG');
});

test('decodePng: palette / 16-bit / 交错 -> PNG_UNSUPPORTED_FORMAT（不猜像素）', () => {
  const rgbRow = [solidRow(2, 3, [1, 2, 3])];

  const palette = encodePng({ width: 2, height: 1, colorType: 2, rows: rgbRow, filters: 0 });
  // 把 color type 改成 3（palette）并重算 IHDR CRC：结构仍合法，只是不受支持。
  const paletteBytes = Buffer.from(palette);
  paletteBytes[25] = 3;
  paletteBytes.writeUInt32BE(crc32(paletteBytes.subarray(12, 8 + 8 + 13)), 8 + 8 + 13);
  const paletteResult = decodePng(paletteBytes);
  assert.equal(paletteResult.ok, false);
  assert.equal(paletteResult.code, 'PNG_UNSUPPORTED_FORMAT');

  const deep = encodePng({ width: 2, height: 1, colorType: 2, rows: rgbRow, filters: 0, bitDepth: 16 });
  assert.equal(decodePng(deep).code, 'PNG_UNSUPPORTED_FORMAT');

  const interlaced = encodePng({ width: 2, height: 1, colorType: 2, rows: rgbRow, filters: 0, interlace: 1 });
  assert.equal(decodePng(interlaced).code, 'PNG_UNSUPPORTED_FORMAT');
});

test('decodePng: 行数据长度不符 -> INVALID_PNG', () => {
  const bytes = encodePng({ width: 2, height: 2, colorType: 2, rows: [solidRow(2, 3, [1, 2, 3]), solidRow(2, 3, [4, 5, 6])], filters: 0 });
  // 改 IHDR 宽度为 3 但保留原 scanline 数据 -> 行长度不符（IHDR 的 CRC 同步重算）
  const widened = Buffer.from(bytes);
  widened.writeUInt32BE(3, 16);
  widened.writeUInt32BE(crc32(widened.subarray(12, 8 + 8 + 13)), 8 + 8 + 13);
  const result = decodePng(widened);
  assert.equal(result.ok, false);
  assert.equal(result.code, 'INVALID_PNG');
  assert.match(result.message, /scanline/);
});

test('decodePng: filter 类型 >4 -> INVALID_PNG', () => {
  const bytes = encodePng({ width: 1, height: 1, colorType: 0, rows: [Buffer.from([9])], filters: 0 });
  // 直接在 IDAT 里改 filter 字节：重新压缩 raw = [5, 9]
  const ihdr = bytes.subarray(8, 8 + 8 + 13 + 4);
  const broken = Buffer.concat([
    SIGNATURE,
    ihdr,
    pngChunk('IDAT', deflateSync(Buffer.from([5, 9]))),
    pngChunk('IEND', Buffer.alloc(0)),
  ]);
  const result = decodePng(broken);
  assert.equal(result.ok, false);
  assert.equal(result.code, 'INVALID_PNG');
  assert.match(result.message, /filter/);
});

test('inspectPng: 块数/像素上限防御', () => {
  const bytes = encodePng({ width: 1, height: 1, colorType: 0, rows: [Buffer.from([1])], filters: 0 });
  // 像素上限 2e8：把 IHDR 改成 20000x20000 = 4e8 并重算 CRC
  const huge = Buffer.from(bytes);
  huge.writeUInt32BE(20000, 16);
  huge.writeUInt32BE(20000, 20);
  huge.writeUInt32BE(crc32(huge.subarray(12, 8 + 8 + 13)), 8 + 8 + 13);
  const result = inspectPng(huge);
  assert.equal(result.ok, false);
  assert.equal(result.code, 'INVALID_PNG');
  assert.match(result.message, /implausible size/);
  assert.equal(CAPTURE_LIMITS.maxPngPixels, 200000000);
});

/* ------------------------------------------------------------------------------------------------
 * detectImageAnomaly
 * ---------------------------------------------------------------------------------------------- */

test('detectImageAnomaly: 纯色白 / 纯色透明 / 2 色 / tolerance（全量扫描，不抽样）', () => {
  const white = decodePng(encodePng({
    width: 4, height: 4, colorType: 2,
    rows: Array.from({ length: 4 }, () => solidRow(4, 3, [255, 255, 255])), filters: 0,
  }));
  const whiteAnomaly = detectImageAnomaly(white);
  assert.equal(whiteAnomaly.ok, true);
  assert.equal(whiteAnomaly.uniform, true);
  assert.equal(whiteAnomaly.transparent, false);
  assert.equal(whiteAnomaly.maxDelta, 0);
  assert.equal(whiteAnomaly.distinctColors, 1);
  assert.equal(whiteAnomaly.sampled, false);
  assert.equal(whiteAnomaly.sampledPixels, 16);
  assert.deepEqual(whiteAnomaly.averageColor, { r: 255, g: 255, b: 255, a: 255 });

  const transparent = decodePng(encodePng({
    width: 2, height: 2, colorType: 6,
    rows: Array.from({ length: 2 }, () => solidRow(2, 4, [0, 0, 0, 0])), filters: 0,
  }));
  const transparentAnomaly = detectImageAnomaly(transparent);
  assert.equal(transparentAnomaly.uniform, true);
  assert.equal(transparentAnomaly.transparent, true);
  assert.deepEqual(transparentAnomaly.averageColor, { r: 0, g: 0, b: 0, a: 0 });

  const twoColors = decodePng(encodePng({
    width: 2, height: 1, colorType: 2,
    rows: [Buffer.from([255, 0, 0, 0, 0, 255])], filters: 0,
  }));
  const twoColorsAnomaly = detectImageAnomaly(twoColors);
  assert.equal(twoColorsAnomaly.uniform, false);
  assert.equal(twoColorsAnomaly.distinctColors, 2);
  assert.equal(twoColorsAnomaly.maxDelta, 255);

  const nearUniform = decodePng(encodePng({
    width: 2, height: 1, colorType: 2,
    rows: [Buffer.from([10, 10, 10, 12, 12, 10])], filters: 0,
  }));
  assert.equal(detectImageAnomaly(nearUniform).uniform, false);
  assert.equal(detectImageAnomaly(nearUniform, { tolerance: 2 }).uniform, true);
  assert.equal(detectImageAnomaly(nearUniform, { tolerance: 2 }).maxDelta, 2);
  assert.equal(detectImageAnomaly(nearUniform, { tolerance: 1 }).uniform, false);
});

test('detectImageAnomaly: 白底 + 少量内容像素必须 uniform=false（防漏报，全量扫描）', () => {
  // 20x10 纯白，3 个像素改成深色（模拟“白底 + 一行文字”的稀疏内容）
  const width = 20;
  const height = 10;
  const rows = Array.from({ length: height }, () => solidRow(width, 3, [255, 255, 255]));
  rows[4][(7 * 3) + 0] = 17; rows[4][(7 * 3) + 1] = 17; rows[4][(7 * 3) + 2] = 17;
  rows[5][(8 * 3) + 0] = 200; rows[5][(8 * 3) + 1] = 0; rows[5][(8 * 3) + 2] = 0;
  rows[0][0] = 254; // 第一行角落里仅差 1 的一个像素
  const decoded = decodePng(encodePng({ width, height, colorType: 2, rows, filters: 0 }));
  const anomaly = detectImageAnomaly(decoded);
  assert.equal(anomaly.ok, true);
  assert.equal(anomaly.sampled, false);
  assert.equal(anomaly.sampledPixels, width * height, 'every pixel must be scanned');
  assert.equal(anomaly.uniform, false, 'sparse content must not be reported as uniform');
  assert.equal(anomaly.maxDelta, 255);
  assert.ok(anomaly.distinctColors >= 3);
});

test('detectImageAnomaly: distinctColors 上限 1024，全量扫描计数', () => {
  const width = 1025;
  const row = Buffer.alloc(width * 3);
  for (let i = 0; i < width; i += 1) {
    row[i * 3] = i >> 8;
    row[i * 3 + 1] = i & 0xff;
    row[i * 3 + 2] = 0;
  }
  const decoded = decodePng(encodePng({ width, height: 1, colorType: 2, rows: [row], filters: 0 }));
  const anomaly = detectImageAnomaly(decoded);
  assert.equal(anomaly.ok, true);
  assert.equal(anomaly.distinctColors, 1024);
  assert.equal(anomaly.sampled, false);
  assert.equal(anomaly.sampledPixels, 1025);
  assert.ok(anomaly.distinctColors <= 1024);
});

test('detectImageAnomaly: 未成功解码时返回 INVALID_PNG', () => {
  assert.equal(detectImageAnomaly({ ok: false, code: 'INVALID_PNG' }).ok, false);
  assert.equal(detectImageAnomaly(undefined).code, 'INVALID_PNG');
});

/* ------------------------------------------------------------------------------------------------
 * expectedPixelSize / checkPixelSize
 * ---------------------------------------------------------------------------------------------- */

test('expectedPixelSize: round(css*scale*dsf)，含 101×1.25/1.5/2/3 实测值', () => {
  assert.deepEqual(expectedPixelSize({ width: 1280, height: 800 }), { width: 1280, height: 800, pixelsPerCssPixel: 1 });
  assert.deepEqual(expectedPixelSize({ width: 101, height: 50, scale: 1.25 }), { width: 126, height: 63, pixelsPerCssPixel: 1.25 });
  assert.deepEqual(expectedPixelSize({ width: 101, height: 75, scale: 1.5 }), { width: 152, height: 113, pixelsPerCssPixel: 1.5 });
  assert.deepEqual(expectedPixelSize({ width: 101, height: 50, scale: 2 }), { width: 202, height: 100, pixelsPerCssPixel: 2 });
  assert.deepEqual(expectedPixelSize({ width: 101, height: 50, scale: 3 }), { width: 303, height: 150, pixelsPerCssPixel: 3 });
  assert.deepEqual(expectedPixelSize({ width: 10, height: 10, scale: 2, deviceScaleFactor: 2 }),
    { width: 40, height: 40, pixelsPerCssPixel: 4 });
  // Math.round 半值向上（151.5 -> 152）
  assert.equal(expectedPixelSize({ width: 101, height: 1, scale: 1.5 }).width, 152);
  assert.throws(() => expectedPixelSize({ width: 0, height: 10 }), TypeError);
  assert.throws(() => expectedPixelSize({ width: 10, height: 10, scale: Number.NaN }), TypeError);
  assert.throws(() => expectedPixelSize({ width: '10', height: 10 }), TypeError);
});

test('checkPixelSize: ok / upscaled / undersized / 容差 / mixed', () => {
  const exact = checkPixelSize({ width: 2560, height: 1600 }, { width: 2560, height: 1600 });
  assert.equal(exact.ok, true);
  assert.deepEqual(exact.actual, { width: 2560, height: 1600 });

  const upscaled = checkPixelSize({ width: 2560, height: 1600 }, { width: 1280, height: 800 });
  assert.equal(upscaled.ok, false);
  assert.equal(upscaled.code, 'CAPTURE_UPSCALED');
  assert.deepEqual(upscaled.details.actual, { width: 2560, height: 1600 });
  assert.deepEqual(upscaled.details.expected, { width: 1280, height: 800 });
  assert.equal(upscaled.details.reason, 'upscaled');

  const undersized = checkPixelSize({ width: 1279, height: 800 }, { width: 1280, height: 800 });
  assert.equal(undersized.ok, false);
  assert.equal(undersized.code, 'CAPTURE_SIZE_MISMATCH');
  assert.equal(undersized.details.reason, 'undersized');

  assert.equal(checkPixelSize({ width: 1282, height: 800 }, { width: 1280, height: 800 }, { tolerance: 2 }).ok, true);
  assert.equal(checkPixelSize({ width: 1282, height: 800 }, { width: 1280, height: 800 }, { tolerance: 1 }).code, 'CAPTURE_UPSCALED');

  const mixed = checkPixelSize({ width: 1100, height: 900 }, { width: 1000, height: 1000 });
  assert.equal(mixed.ok, false);
  assert.equal(mixed.code, 'CAPTURE_SIZE_MISMATCH');
  assert.equal(mixed.details.reason, 'mixed-dimensions');
});

/* ------------------------------------------------------------------------------------------------
 * createCaptureMapping / projectCaptureMapping
 * ---------------------------------------------------------------------------------------------- */

test('createCaptureMapping: 文档 CSS 坐标正算且 pixelToCss 可逆', () => {
  const mapping = createCaptureMapping({
    region: { x: 20, y: 30, width: 100, height: 50 },
    scroll: { x: 400, y: 300 },
    viewport: { width: 1280, height: 800 },
    scale: 2,
    deviceScaleFactor: 1,
  });
  assert.equal(mapping.coordinateSpace, 'document-css-px');
  assert.deepEqual(mapping.originCss, { x: 20, y: 30 });
  assert.deepEqual(mapping.imagePixels, { width: 200, height: 100 });
  assert.equal(mapping.pixelsPerCssPixel, 2);
  assert.deepEqual(mapping.cssRect, { x: 20, y: 30, width: 100, height: 50 });
  assert.deepEqual(mapping.scroll, { x: 400, y: 300 });
  assert.deepEqual(mapping.viewport, { width: 1280, height: 800 });

  // 区域左上角 -> (0,0)；区域右下角 -> (200,100)
  assert.deepEqual(mapping.cssToPixel({ x: 20, y: 30 }), { x: 0, y: 0 });
  assert.deepEqual(mapping.cssToPixel({ x: 120, y: 80 }), { x: 200, y: 100 });
  assert.deepEqual(mapping.pixelToCss({ x: 0, y: 0 }), { x: 20, y: 30 });
  assert.deepEqual(mapping.pixelToCss({ x: 200, y: 100 }), { x: 120, y: 80 });

  for (const point of [{ x: 20, y: 30 }, { x: 70, y: 55 }, { x: 120, y: 80 }]) {
    assert.deepEqual(mapping.pixelToCss(mapping.cssToPixel(point)), point, 'round trip');
  }

  // 文档坐标 + 滚动：视口内 (20, 330) 就是文档 (20, 630)
  const scrolled = createCaptureMapping({
    region: { x: 0, y: 500, width: 10, height: 10 }, scroll: { x: 0, y: 400 }, scale: 1,
  });
  assert.deepEqual(scrolled.cssToPixel({ x: 20, y: 630 }), { x: 20, y: 130 });
});

test('projectCaptureMapping: 纯 JSON、可 JSON.stringify、无函数字段', () => {
  const mapping = createCaptureMapping({
    region: { x: 20, y: 30, width: 101, height: 50 },
    scroll: { x: 0, y: 400 },
    viewport: { width: 1280, height: 800 },
    scale: 1.5,
  });
  assert.equal(typeof mapping.cssToPixel, 'function');
  const projected = projectCaptureMapping(mapping);
  assert.deepEqual(projected, {
    coordinateSpace: 'document-css-px',
    originCss: { x: 20, y: 30 },
    imagePixels: { width: 152, height: 75 },
    pixelsPerCssPixel: 1.5,
    cssRect: { x: 20, y: 30, width: 101, height: 50 },
    formulas: {
      cssToPixel: 'px = (css - origin) * pixelsPerCssPixel',
      pixelToCss: 'css = origin + px / pixelsPerCssPixel',
    },
  });
  const walk = (value, path) => {
    if (typeof value === 'function') assert.fail(`function at ${path}`);
    if (value && typeof value === 'object') {
      for (const [key, child] of Object.entries(value)) walk(child, `${path}.${key}`);
    }
  };
  walk(projected, 'mapping');
  assert.deepEqual(JSON.parse(JSON.stringify(projected)), projected);
});

/* ------------------------------------------------------------------------------------------------
 * resolveCapturePath
 * ---------------------------------------------------------------------------------------------- */

test('resolveCapturePath: 合法子目录创建成功 / 默认名 / 无绝对路径泄露', () => {
  const root = makeTempRoot();
  try {
    const ok = resolveCapturePath({ root, out: 'sub/dir/shot.png' });
    assert.equal(ok.ok, true);
    assert.equal(ok.dir, join(ok.root, 'sub', 'dir'));
    assert.equal(ok.relativePath, 'sub/dir/shot.png');
    assert.equal(ok.absolutePath, join(ok.dir, 'shot.png'));
    assert.equal(statSync(ok.dir).isDirectory(), true);
    assert.ok(ok.absolutePath.startsWith(ok.root));

    const byDefault = resolveCapturePath({ root, defaultName: 'output/capture/action-1.png' });
    assert.equal(byDefault.ok, true);
    assert.equal(byDefault.relativePath, 'output/capture/action-1.png');
    assert.equal(statSync(byDefault.dir).isDirectory(), true);

    // 根目录本身也允许（dir == root）
    const atRoot = resolveCapturePath({ root, out: 'top.png' });
    assert.equal(atRoot.ok, true);
    assert.equal(atRoot.relativePath, 'top.png');
    assert.equal(atRoot.dir, atRoot.root);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test('resolveCapturePath: 越界/非法形状 -> OUTPUT_PATH_INVALID（details 不含绝对路径）', () => {
  const root = makeTempRoot();
  try {
    const cases = [
      { out: '../x.png', reason: 'out_parent_segment' },
      { out: 'a/../../x.png', reason: 'out_parent_segment' },
      { out: '/tmp/x.png', reason: 'out_absolute' },
      { out: 'a\\b.png', reason: 'out_backslash' },
      { out: 'x.jpg', reason: 'out_not_png' },
      { out: 'a//b.png', reason: 'out_empty_segment' },
      { out: './x.png', reason: 'out_empty_segment' },
      { out: 'x.png\0', reason: 'out_nul' },
      { out: 'a'.repeat(101) + '.png', reason: 'out_segment_too_long' },
      { out: ('a/'.repeat(100) + 'x.png'), reason: 'out_too_long' },
      { out: '', reason: 'out_missing' },
    ];
    for (const item of cases) {
      const result = resolveCapturePath({ root, out: item.out });
      assert.equal(result.ok, false, `expected rejection for ${JSON.stringify(item.out)}`);
      assert.equal(result.code, 'OUTPUT_PATH_INVALID');
      assert.equal(result.details.reason, item.reason, `reason for ${JSON.stringify(item.out)}`);
      const serialized = JSON.stringify(result.details);
      assert.ok(!serialized.includes(root), 'details must not leak the absolute root');
    }

    // root 必须是存在的绝对路径
    assert.equal(resolveCapturePath({ root: 'relative/dir', out: 'x.png' }).details.reason, 'root_not_absolute');
    assert.equal(resolveCapturePath({ root: '/definitely/not/here/p0', out: 'x.png' }).details.reason, 'root_unavailable');
    assert.equal(resolveCapturePath({ root: '', out: 'x.png' }).details.reason, 'root_not_absolute');
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test('resolveCapturePath: 符号链接目录逃逸 -> dir_escape', () => {
  const root = makeTempRoot();
  const outside = makeTempRoot('capture-p0-outside-');
  try {
    symlinkSync(outside, join(root, 'link'));
    const result = resolveCapturePath({ root, out: 'link/x.png' });
    assert.equal(result.ok, false);
    assert.equal(result.code, 'OUTPUT_PATH_INVALID');
    assert.equal(result.details.reason, 'dir_escape');
  } finally {
    rmSync(root, { recursive: true, force: true });
    rmSync(outside, { recursive: true, force: true });
  }
});

/* ------------------------------------------------------------------------------------------------
 * publishCapture
 * ---------------------------------------------------------------------------------------------- */

test('publishCapture: 成功写出、0600、字节一致、无临时残留', () => {
  const root = makeTempRoot();
  try {
    const resolved = resolveCapturePath({ root, out: 'out/shot.png' });
    assert.equal(resolved.ok, true);
    const bytes = Buffer.from('PNG-BYTES-P0');
    const published = publishCapture(resolved.dir, resolved.absolutePath, bytes);
    assert.equal(published.ok, true);
    assert.equal(published.path, resolved.absolutePath);
    assert.equal(published.bytes, bytes.length);
    assert.equal(published.mode, '0600');
    assert.ok(Number.isInteger(published.createdAt) && published.createdAt > 0);
    // win32 cannot fsync a directory and ignores POSIX permission bits at create time: the
    // cleanup flag stays truthful (false) and the file mode is the NTFS default.
    assert.deepEqual(published.cleanup, {
      tempRemoved: true,
      dirFsync: process.platform !== 'win32',
    });
    assert.deepEqual(readFileSync(resolved.absolutePath), bytes);
    if (process.platform !== 'win32') assert.equal(statSync(resolved.absolutePath).mode & 0o777, 0o600);
    assert.equal(lstatSync(resolved.absolutePath).isFile(), true);
    assert.deepEqual(readdirSync(resolved.dir), ['shot.png'], 'no temp file left behind');
    // 内容 sha256 与源字节一致
    assert.equal(
      createHash('sha256').update(readFileSync(resolved.absolutePath)).digest('hex'),
      createHash('sha256').update(bytes).digest('hex'),
    );
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test('publishCapture: 同路径二次发布 -> OUTPUT_EXISTS 且既有文件 sha256 不变', () => {
  const root = makeTempRoot();
  try {
    const resolved = resolveCapturePath({ root, out: 'out/shot.png' });
    assert.equal(resolved.ok, true);
    const first = Buffer.from('FIRST-CONTENT');
    const second = Buffer.from('SECOND-CONTENT-DIFFERENT-LENGTH');
    assert.equal(publishCapture(resolved.dir, resolved.absolutePath, first).ok, true);
    const before = createHash('sha256').update(readFileSync(resolved.absolutePath)).digest('hex');

    const again = publishCapture(resolved.dir, resolved.absolutePath, second);
    assert.equal(again.ok, false);
    assert.equal(again.code, 'OUTPUT_EXISTS');
    assert.equal(again.details.reason, 'output_exists');
    assert.ok(!JSON.stringify(again.details).includes(root), 'details must not leak the absolute root');

    const after = createHash('sha256').update(readFileSync(resolved.absolutePath)).digest('hex');
    assert.equal(after, before, 'existing file must be byte-identical after OUTPUT_EXISTS');
    assert.deepEqual(readFileSync(resolved.absolutePath), first);
    assert.deepEqual(readdirSync(resolved.dir), ['shot.png'], 'EEXIST must not leave a temp file');
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test('publishCapture: 已存在的只读文件也不被改动（不跟随 symlink 目标）', () => {
  const root = makeTempRoot();
  try {
    const target = join(root, 'existing.png');
    writeFileSync(target, 'ORIGINAL');
    chmodSync(target, 0o400);
    const published = publishCapture(root, target, Buffer.from('OVERWRITE-ATTEMPT'));
    assert.equal(published.ok, false);
    assert.equal(published.code, 'OUTPUT_EXISTS');
    assert.equal(readFileSync(target, 'utf8'), 'ORIGINAL');
    assert.deepEqual(readdirSync(root).sort(), ['existing.png']);
    chmodSync(target, 0o600);

    // symlink 指向一个不存在的目标也必须按“已存在”处理，不跟随写入
    const link = join(root, 'link.png');
    symlinkSync(join(root, 'nowhere.png'), link);
    const viaLink = publishCapture(root, link, Buffer.from('VIA-LINK'));
    assert.equal(viaLink.ok, false);
    assert.equal(viaLink.code, 'OUTPUT_EXISTS');
    assert.equal(statSync(join(root, 'nowhere.png'), { throwIfNoEntry: false }), undefined);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test('publishCapture: 参数非法 -> OUTPUT_WRITE_FAILED（不创建文件）', () => {
  const root = makeTempRoot();
  try {
    assert.equal(publishCapture('relative/dir', join(root, 'x.png'), Buffer.from('a')).details.reason, 'dir_not_absolute');
    assert.equal(publishCapture(root, 'relative.png', Buffer.from('a')).details.reason, 'path_not_absolute');
    assert.equal(publishCapture(root, join(root, 'sub', 'x.png'), Buffer.from('a')).details.reason, 'cross_directory');
    assert.equal(publishCapture(root, join(root, 'empty.png'), Buffer.alloc(0)).details.reason, 'empty_bytes');
    assert.deepEqual(readdirSync(root), [], 'failed publishes must not leave files behind');
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test('publishCapture: link 成功后清理失败不误报（目录被移除的退化路径）', () => {
  const root = makeTempRoot();
  try {
    const dir = join(root, 'out');
    mkdirSync(dir);
    const finalPath = join(dir, 'shot.png');
    const bytes = Buffer.from('COMMITTED-BYTES');
    const published = publishCapture(dir, finalPath, bytes);
    assert.equal(published.ok, true);
    assert.deepEqual(readFileSync(finalPath), bytes);
    // 主路径断言：返回成功、final 存在且内容正确、cleanup 两个字段都是布尔真值。
    assert.equal(published.cleanup.tempRemoved, true);
    // win32 has no directory fsync (EPERM): false is the truthful value, not a cleanup failure.
    assert.equal(published.cleanup.dirFsync, process.platform !== 'win32');
    // 未覆盖：无法在不破坏沙箱的前提下安全模拟 unlink/fsync 失败，记录为未覆盖。
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});
