/**
 * capture-p0.js — P0 采集基础设施的纯逻辑层（零第三方依赖，可单测）。
 *
 * 只回答四类问题，不做采集/不做工具编排：
 *   1. 这段字节是不是一张结构完整、尺寸可信的 PNG？            inspectPng / decodePng
 *   2. 这张图是不是异常空白（纯色 / 全透明）？                  detectImageAnomaly
 *   3. PNG 像素尺寸符合 clip 尺寸 × scale × dsf 的期望吗？       expectedPixelSize / checkPixelSize
 *   4. 输出路径是否在工作区内、能否原子且不覆盖地落盘？          createCaptureMapping /
 *                                                               resolveCapturePath / publishCapture
 *
 * 设计约束（与 docs/capture-p0.md 一致）：
 *  - 只依赖 node:zlib / node:fs / node:path / node:crypto；同步 fs；无全局可变状态。
 *  - 失败一律返回结构化对象 `{ok:false, code, message, details}`，不向调用方抛裸异常
 *    （expectedPixelSize 是纯算术 helper，参数非法时抛 TypeError 由调用方先行校验）。
 *  - 返回对象里的 details 只放相对路径/数值，不放绝对路径，避免进工具证据时泄露工作区绝对路径。
 *  - 不含任何像素/页面原文日志。
 *
 * 采集语义（Lead 在本机 Chrome 152 + Linux headless 实测）：
 *  - `Page.captureScreenshot` 的 `clip` 是文档 CSS 坐标；输出像素 = round(css * scale * dsf)。
 *  - `clip.scale` 是重新光栅化，不是位图放大；本插件固定 dsf=1，只用 clip.scale。
 *  - 因此 CAPTURE_UPSCALED 只证明“输出尺寸大于期望尺寸”，不单独证明发生了位图放大。
 *  - scale 允许 0.1–4（Lead 冻结，见 docs/viewport-control.md §6.1）；实测 clip.scale=0.1/0.5/
 *    0.65/1.11 时 PNG 尺寸都精确等于 round(css×scale)（取整发生在 clip 的 CSS 尺寸上，不是
 *    scale 上），所以 0 容差公式不变，只需额外拒绝两轴 <1 的空输出（hasPositiveOutputSize）。
 */

import { randomUUID } from 'node:crypto';
import {
  closeSync, fsyncSync, linkSync, mkdirSync, openSync, realpathSync, statSync,
  unlinkSync, writeSync,
} from 'node:fs';
import { basename, dirname, isAbsolute, join, relative, resolve, sep } from 'node:path';
import { inflateSync } from 'node:zlib';

/** 8 字节 PNG 文件签名。 */
export const PNG_SIGNATURE = Uint8Array.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);

/** 结构遍历上限：坏文件不许让循环跑太久。 */
const MAX_CHUNKS = 100000;

/** PNG 允许声明的像素上限（防御异常尺寸）。 */
const MAX_PIXELS = 200000000;

/** 空白识别最多实际读取的像素数（更大图按步长抽样，避免解码后全量扫描）。 */
const MAX_ANOMALY_SAMPLES = 65536;

/** distinctColors 统计上限：超过即按 1024 记（“≥1024”）。 */
const MAX_DISTINCT_COLORS = 1024;

/** P0 采集的公共限额（index.js / browser_capabilities 复用，避免魔法数字漂移）。 */
export const CAPTURE_LIMITS = Object.freeze({
  /**
   * 显式 scale 允许范围（闭区间）。
   *
   * 2026-11-01（docs/viewport-control.md §6.1，Lead 冻结）：下界从 1 扩到 0.1，因为共享
   * `view.scale` 可以是 10%（0.1）而默认截图比例跟随它。上界仍是 4。默认值**不是** scaleMin：
   * 省略 scale 时由 Host 在调用内解析为当前 `view.scale`（cold 时为 1）。
   */
  scaleMin: 0.1,
  scaleMax: 4,
  /** 输出像素的下界：任一轴 < 1 时 Chrome 会取整成 0 像素，必须在 CDP 截图前拒绝。 */
  minOutputPixels: 1,
  /** 单次截图期望像素上限（宽×高）；超过即 CAPTURE_TOO_LARGE，必须在 CDP 截图前判定。 */
  maxOutputPixels: 16000000,
  /** PNG 结构/解码预算之外的硬上限，避免异常 IHDR 拖垮解码。 */
  maxPngPixels: MAX_PIXELS,
});

/** PNG color type -> 通道数（仅 8-bit 非交错支持）。 */
const COLOR_TYPE_CHANNELS = Object.freeze({ 0: 1, 2: 3, 4: 2, 6: 4 });

let crcTable = null;

function getCrcTable() {
  if (crcTable) return crcTable;
  const table = new Int32Array(256);
  for (let n = 0; n < 256; n += 1) {
    let c = n;
    for (let k = 0; k < 8; k += 1) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
    table[n] = c;
  }
  crcTable = table;
  return table;
}

/** Buffer / Uint8Array / ArrayBuffer 统一成 Buffer（不拷贝已有 Buffer）；其它类型返回 null。 */
export function asBuffer(bytes) {
  if (Buffer.isBuffer(bytes)) return bytes;
  if (bytes instanceof Uint8Array) return Buffer.from(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  if (bytes instanceof ArrayBuffer) return Buffer.from(bytes);
  return null;
}

/** CRC32（PNG 规范定义）。 */
export function crc32(bytes) {
  const buf = asBuffer(bytes) || Buffer.alloc(0);
  const table = getCrcTable();
  let c = 0xffffffff;
  for (let i = 0; i < buf.length; i += 1) c = table[(c ^ buf[i]) & 0xff] ^ (c >>> 8);
  return (c ^ 0xffffffff) >>> 0;
}

function invalidPng(message) {
  return { ok: false, code: 'INVALID_PNG', message };
}

function unsupportedFormat(message) {
  return { ok: false, code: 'PNG_UNSUPPORTED_FORMAT', message };
}

/**
 * PNG 结构校验：签名、块边界、IHDR(13)、IEND、截断、IEND 后尾部字节、CRC32。
 *
 * @param {Uint8Array|Buffer} bytes
 * @param {{ checkCrc?: boolean }} [options]
 * @returns {{ok:true,width:number,height:number,bytes:number,chunks:number}
 *          |{ok:false,code:'INVALID_PNG',message:string}}
 */
export function inspectPng(bytes, { checkCrc = true } = {}) {
  const buf = asBuffer(bytes);
  if (!buf || buf.length === 0) return invalidPng('PNG bytes are empty');
  if (buf.length < 8) return invalidPng('PNG bytes are shorter than the 8-byte signature');
  if (!buf.subarray(0, 8).equals(Buffer.from(PNG_SIGNATURE))) {
    return invalidPng('PNG signature mismatch (89 50 4E 47 0D 0A 1A 0A expected)');
  }

  let offset = 8;
  let chunks = 0;
  let ihdr = null;
  let sawIend = false;

  while (offset < buf.length) {
    if (chunks >= MAX_CHUNKS) return invalidPng('PNG has an implausible number of chunks');
    if (offset + 8 > buf.length) return invalidPng('PNG is truncated inside a chunk header');

    const length = buf.readUInt32BE(offset);
    const type = buf.toString('latin1', offset + 4, offset + 8);
    const dataStart = offset + 8;
    const dataEnd = dataStart + length;
    const crcEnd = dataEnd + 4;

    if (!/^[A-Za-z]{4}$/.test(type)) return invalidPng(`PNG chunk type is invalid at offset ${offset}`);
    if (dataEnd > buf.length || crcEnd > buf.length) return invalidPng(`PNG is truncated inside chunk ${type}`);

    if (chunks === 0) {
      if (type !== 'IHDR' || length !== 13) return invalidPng('PNG first chunk is not a 13-byte IHDR');
      const width = buf.readUInt32BE(dataStart);
      const height = buf.readUInt32BE(dataStart + 4);
      if (!(width > 0) || !(height > 0)) return invalidPng('PNG IHDR declares a non-positive size');
      if (width * height > MAX_PIXELS) {
        return invalidPng(`PNG IHDR declares an implausible size ${width}x${height}`);
      }
      ihdr = { width, height };
    }

    if (checkCrc) {
      const expected = buf.readUInt32BE(dataEnd);
      const actual = crc32(buf.subarray(offset + 4, dataEnd));
      if (expected !== actual) return invalidPng(`PNG chunk ${type} failed its CRC check`);
    }

    offset = crcEnd;
    chunks += 1;

    if (type === 'IEND') {
      if (length !== 0) return invalidPng('PNG IEND chunk is not empty');
      sawIend = true;
      break;
    }
  }

  if (!sawIend) return invalidPng('PNG has no IEND chunk (truncated or corrupt)');
  if (offset !== buf.length) return invalidPng(`PNG has ${buf.length - offset} trailing bytes after IEND`);
  if (!ihdr) return invalidPng('PNG has no IHDR');

  return { ok: true, width: ihdr.width, height: ihdr.height, bytes: buf.length, chunks };
}

function paethPredictor(a, b, c) {
  const p = a + b - c;
  const pa = Math.abs(p - a);
  const pb = Math.abs(p - b);
  const pc = Math.abs(p - c);
  if (pa <= pb && pa <= pc) return a;
  if (pb <= pc) return b;
  return c;
}

/**
 * 解码 8-bit、color type 0/2/4/6、filter 0–4、非交错 PNG，返回逐行原始通道字节。
 *
 * palette(3) / 16-bit / 交错一律 PNG_UNSUPPORTED_FORMAT —— 不猜像素。
 * 结构坏（签名/截断/CRC/IDAT 解压/行长度不符）一律 INVALID_PNG。
 *
 * @param {Uint8Array|Buffer} bytes
 * @returns {{ok:true,width:number,height:number,channels:number,colorType:number,data:Buffer}
 *          |{ok:false,code:'INVALID_PNG'|'PNG_UNSUPPORTED_FORMAT',message:string}}
 */
export function decodePng(bytes) {
  const inspected = inspectPng(bytes);
  if (!inspected.ok) return inspected;
  const buf = asBuffer(bytes);
  const bitDepth = buf[24];
  const colorType = buf[25];
  const interlace = buf[28];
  if (bitDepth !== 8) return unsupportedFormat(`PNG bit depth ${bitDepth} is not supported (only 8-bit)`);
  const channels = COLOR_TYPE_CHANNELS[colorType];
  if (!channels) return unsupportedFormat(`PNG color type ${colorType} is not supported (0/2/4/6 only)`);
  if (interlace !== 0) return unsupportedFormat('interlaced PNG is not supported');

  const { width, height } = inspected;
  const stride = width * channels;
  const expectedLength = (stride + 1) * height;

  // 收集全部 IDAT 数据（Chrome 会输出多块 IDAT）。
  const parts = [];
  let offset = 8;
  while (offset < buf.length) {
    const length = buf.readUInt32BE(offset);
    const type = buf.toString('latin1', offset + 4, offset + 8);
    if (type === 'IDAT') parts.push(buf.subarray(offset + 8, offset + 8 + length));
    offset += 8 + length + 4;
    if (type === 'IEND') break;
  }
  if (!parts.length) return invalidPng('PNG has no IDAT chunk');

  let raw;
  try {
    raw = inflateSync(Buffer.concat(parts));
  } catch (error) {
    return invalidPng(`PNG IDAT cannot be inflated (${error && error.message ? error.message : 'zlib error'})`);
  }
  if (raw.length !== expectedLength) {
    return invalidPng(`PNG scanline data is ${raw.length} bytes, expected ${expectedLength}`);
  }

  const data = Buffer.alloc(stride * height);
  for (let y = 0; y < height; y += 1) {
    const filter = raw[y * (stride + 1)];
    if (filter > 4) return invalidPng(`PNG row ${y} uses unsupported filter type ${filter}`);
    const inStart = y * (stride + 1) + 1;
    const outStart = y * stride;
    const upStart = outStart - stride;
    for (let i = 0; i < stride; i += 1) {
      const x = raw[inStart + i];
      const left = i >= channels ? data[outStart + i - channels] : 0;
      const up = y > 0 ? data[upStart + i] : 0;
      const upLeft = y > 0 && i >= channels ? data[upStart + i - channels] : 0;
      let value;
      switch (filter) {
        case 0: value = x; break;
        case 1: value = x + left; break;
        case 2: value = x + up; break;
        case 3: value = x + Math.floor((left + up) / 2); break;
        default: value = x + paethPredictor(left, up, upLeft); break;
      }
      data[outStart + i] = value & 0xff;
    }
  }

  return { ok: true, width, height, channels, colorType, data };
}

/**
 * 异常空白图识别。
 *
 * uniform = 所有被扫描的像素，各通道相对“首个像素”的差都 <= tolerance。
 * transparent = 有 alpha 通道（GA/RGBA）且全部被扫描像素 alpha 为 0。
 *
 * **默认全量扫描**：像素数 <= CAPTURE_LIMITS.maxOutputPixels（截图输出上限，实际总满足）时逐像素扫描，
 * 不做抽样 —— “大面积纯色 + 少量内容”的页面（白底 + 一行 13px 文字）因此不会误报 uniform。
 * 只有超过该上限的图才按步长抽样，并在 `sampled` 显式标记（`sampledPixels` 是实际扫描数）；
 * 截图路径永远走全量分支。
 *
 * 纯色页面是合法结果，因此这里只出事实，由调用方决定是否告警（P0 只告警不报错）。
 *
 * @param {{ok:true,width:number,height:number,channels:number,data:Buffer}} decoded
 * @param {{tolerance?:number}} [options]
 * @returns {{ok:true,sampled:boolean,sampledPixels:number,uniform:boolean,transparent:boolean,
 *            maxDelta:number,distinctColors:number,averageColor:{r:number,g:number,b:number,a:number}}
 *          |{ok:false,code:'INVALID_PNG',message:string}}
 */
export function detectImageAnomaly(decoded, { tolerance = 0 } = {}) {
  if (!decoded || decoded.ok !== true) {
    return invalidPng('a successfully decoded image is required');
  }
  const { width, height, channels, data } = decoded;
  if (!Number.isInteger(width) || !Number.isInteger(height) || width <= 0 || height <= 0
    || !Number.isInteger(channels) || channels < 1 || !Buffer.isBuffer(data)) {
    return invalidPng('decoded image metadata is inconsistent');
  }
  const total = width * height;
  if (data.length < total * channels) return invalidPng('decoded pixel buffer is shorter than its dimensions');
  const tol = Number.isFinite(tolerance) && tolerance > 0 ? tolerance : 0;
  const hasAlpha = channels === 2 || channels === 4;
  const alphaOffset = channels - 1;

  const fullScan = total <= CAPTURE_LIMITS.maxOutputPixels;
  const step = fullScan ? 1 : Math.ceil(total / MAX_ANOMALY_SAMPLES);
  const isSampled = step > 1;
  const first = 0;
  const firstBase = first * channels;
  const base = [data[firstBase], data[firstBase + 1], data[firstBase + 2], data[firstBase + 3]];

  let scanned = 0;
  let maxDelta = 0;
  let transparent = hasAlpha;
  let sumR = 0; let sumG = 0; let sumB = 0; let sumA = 0;
  const distinct = new Set();

  for (let pixel = 0; pixel < total; pixel += step) {
    const base0 = pixel * channels;
    let r; let g; let b; let a;
    if (channels === 1) { r = data[base0]; g = r; b = r; a = 255; }
    else if (channels === 2) { r = data[base0]; g = r; b = r; a = data[base0 + 1]; }
    else if (channels === 3) { r = data[base0]; g = data[base0 + 1]; b = data[base0 + 2]; a = 255; }
    else { r = data[base0]; g = data[base0 + 1]; b = data[base0 + 2]; a = data[base0 + 3]; }

    const deltas = channels === 1
      ? [Math.abs(data[base0] - base[0])]
      : channels === 2
        ? [Math.abs(data[base0] - base[0]), Math.abs(data[base0 + 1] - base[1])]
        : channels === 3
          ? [Math.abs(data[base0] - base[0]), Math.abs(data[base0 + 1] - base[1]), Math.abs(data[base0 + 2] - base[2])]
          : [Math.abs(data[base0] - base[0]), Math.abs(data[base0 + 1] - base[1]),
            Math.abs(data[base0 + 2] - base[2]), Math.abs(data[base0 + 3] - base[3])];
    for (const delta of deltas) if (delta > maxDelta) maxDelta = delta;

    if (hasAlpha && data[base0 + alphaOffset] !== 0) transparent = false;

    sumR += r; sumG += g; sumB += b; sumA += a;
    scanned += 1;
    if (distinct.size < MAX_DISTINCT_COLORS) {
      distinct.add((r << 24) | (g << 16) | (b << 8) | a);
    }
  }

  return {
    ok: true,
    sampled: isSampled,
    sampledPixels: scanned,
    uniform: maxDelta <= tol,
    transparent,
    maxDelta,
    distinctColors: distinct.size,
    averageColor: {
      r: Math.round(sumR / scanned),
      g: Math.round(sumG / scanned),
      b: Math.round(sumB / scanned),
      a: Math.round(sumA / scanned),
    },
  };
}

/**
 * 输出尺寸下界：两轴都必须 ≥ CAPTURE_LIMITS.minOutputPixels（1）。
 *
 * `round(css × scale)` 在 scale<1 且矩形很小时可能舍入到 0（例如 1 CSS px @0.1 = 0.1 → 0）。
 * Chrome 对这种 clip 不会给出可用的 PNG，所以调用方必须在派发 CDP 截图**之前**用本函数拒绝
 * （`INVALID_ARGUMENT` / reason=`empty-output-dimensions`），不能偷偷升到 1px 再截。
 *
 * @param {{width:number,height:number}} expected
 * @returns {boolean}
 */
export function hasPositiveOutputSize(expected) {
  if (!expected || typeof expected !== 'object') return false;
  return Number.isFinite(expected.width) && Number.isFinite(expected.height)
    && expected.width >= CAPTURE_LIMITS.minOutputPixels
    && expected.height >= CAPTURE_LIMITS.minOutputPixels;
}

/**
 * 期望输出像素尺寸：width = round(cssWidth * scale * deviceScaleFactor)。
 * 纯算术 helper：参数非法时抛 TypeError（调用方负责先用工具层校验）。
 *
 * @param {{width:number,height:number,scale?:number,deviceScaleFactor?:number}} input
 * @returns {{width:number,height:number,pixelsPerCssPixel:number}}
 */
export function expectedPixelSize({ width, height, scale = 1, deviceScaleFactor = 1 } = {}) {
  for (const [name, value] of [['width', width], ['height', height], ['scale', scale], ['deviceScaleFactor', deviceScaleFactor]]) {
    if (typeof value !== 'number' || !Number.isFinite(value) || value <= 0) {
      throw new TypeError(`expectedPixelSize: ${name} must be a positive finite number`);
    }
  }
  const pixelsPerCssPixel = scale * deviceScaleFactor;
  return {
    width: Math.round(width * pixelsPerCssPixel),
    height: Math.round(height * pixelsPerCssPixel),
    pixelsPerCssPixel,
  };
}

/**
 * 尺寸校验：实际 PNG 像素 vs 期望像素。
 *
 * - 任一维 > expected + tolerance 且没有一维 < expected - tolerance -> CAPTURE_UPSCALED
 * - 任一维 < expected - tolerance -> CAPTURE_SIZE_MISMATCH（两向都不符时 reason=mixed-dimensions）
 * 注意：CAPTURE_UPSCALED 只证明“尺寸超标”，不单独证明发生了位图放大。
 *
 * @param {{width:number,height:number}} actual
 * @param {{width:number,height:number}} expected
 * @param {{tolerance?:number}} [options]
 * @returns {{ok:true,actual:{width:number,height:number},expected:{width:number,height:number}}
 *          |{ok:false,code:'CAPTURE_UPSCALED'|'CAPTURE_SIZE_MISMATCH',details:object}}
 */
export function checkPixelSize(actual, expected, { tolerance = 0 } = {}) {
  const tol = Number.isFinite(tolerance) && tolerance > 0 ? tolerance : 0;
  const a = { width: Number(actual && actual.width), height: Number(actual && actual.height) };
  const e = { width: Number(expected && expected.width), height: Number(expected && expected.height) };
  const oversized = a.width > e.width + tol || a.height > e.height + tol;
  const undersized = a.width < e.width - tol || a.height < e.height - tol;

  if (!oversized && !undersized) {
    return { ok: true, actual: { width: a.width, height: a.height }, expected: { width: e.width, height: e.height } };
  }
  const details = {
    actual: { width: a.width, height: a.height },
    expected: { width: e.width, height: e.height },
    tolerance: tol,
    reason: oversized && undersized ? 'mixed-dimensions' : oversized ? 'upscaled' : 'undersized',
  };
  return { ok: false, code: oversized && !undersized ? 'CAPTURE_UPSCALED' : 'CAPTURE_SIZE_MISMATCH', details };
}

/**
 * 文档 CSS 坐标 -> 图像像素的映射（含可逆函数；进工具结果前必须用 projectCaptureMapping 投影）。
 *
 * @param {{region:{x:number,y:number,width:number,height:number},
 *          scroll?:{x:number,y:number}, viewport?:{width:number,height:number},
 *          scale?:number, deviceScaleFactor?:number}} input
 */
export function createCaptureMapping({ region, scroll = { x: 0, y: 0 }, viewport, scale = 1, deviceScaleFactor = 1 } = {}) {
  if (!region || !Number.isFinite(region.width) || !Number.isFinite(region.height)) {
    throw new TypeError('createCaptureMapping: region with finite width/height is required');
  }
  const cssRect = {
    x: Number(region.x) || 0,
    y: Number(region.y) || 0,
    width: Number(region.width),
    height: Number(region.height),
  };
  const imagePixels = expectedPixelSize({
    width: cssRect.width,
    height: cssRect.height,
    scale,
    deviceScaleFactor,
  });
  const originCss = { x: cssRect.x, y: cssRect.y };
  const ppcp = imagePixels.pixelsPerCssPixel;
  return {
    coordinateSpace: 'document-css-px',
    originCss,
    imagePixels: { width: imagePixels.width, height: imagePixels.height },
    pixelsPerCssPixel: ppcp,
    cssRect,
    scroll: { x: Number(scroll.x) || 0, y: Number(scroll.y) || 0 },
    viewport: viewport
      ? { width: Number(viewport.width) || 0, height: Number(viewport.height) || 0 }
      : null,
    cssToPixel({ x, y }) {
      return {
        x: Math.round((Number(x) - originCss.x) * ppcp),
        y: Math.round((Number(y) - originCss.y) * ppcp),
      };
    },
    pixelToCss({ x, y }) {
      return {
        x: originCss.x + Number(x) / ppcp,
        y: originCss.y + Number(y) / ppcp,
      };
    },
  };
}

/**
 * 把 createCaptureMapping 的结果投影成纯 JSON（工具返回值不含函数）。
 *
 * @param {ReturnType<typeof createCaptureMapping>} mapping
 * @returns {{coordinateSpace:string,originCss:object,imagePixels:object,pixelsPerCssPixel:number,
 *            cssRect:object,formulas:{cssToPixel:string,pixelToCss:string}}}
 */
export function projectCaptureMapping(mapping) {
  const source = mapping || {};
  const origin = source.originCss || { x: 0, y: 0 };
  const pixels = source.imagePixels || { width: 0, height: 0 };
  const rect = source.cssRect || { x: 0, y: 0, width: 0, height: 0 };
  return {
    coordinateSpace: source.coordinateSpace === 'document-css-px' ? 'document-css-px' : 'document-css-px',
    originCss: { x: Number(origin.x) || 0, y: Number(origin.y) || 0 },
    imagePixels: { width: Number(pixels.width) || 0, height: Number(pixels.height) || 0 },
    pixelsPerCssPixel: Number(source.pixelsPerCssPixel) || 0,
    cssRect: {
      x: Number(rect.x) || 0,
      y: Number(rect.y) || 0,
      width: Number(rect.width) || 0,
      height: Number(rect.height) || 0,
    },
    formulas: {
      cssToPixel: 'px = (css - origin) * pixelsPerCssPixel',
      pixelToCss: 'css = origin + px / pixelsPerCssPixel',
    },
  };
}

function pathInvalid(message, details) {
  return { ok: false, code: 'OUTPUT_PATH_INVALID', message, details };
}

function isInside(root, target) {
  const rel = relative(root, target);
  if (rel === '') return true;
  if (isAbsolute(rel)) return false;
  return rel !== '..' && !rel.startsWith('..' + sep);
}

/**
 * 校验 out（工作区相对的 POSIX .png 路径），创建目录并做 realpath 越界守卫。
 *
 * 拒绝：绝对路径、反斜杠、NUL、空段、`.`/`..` 段、非 .png 结尾、
 * 总长 >200 字节或单段 >100 字节；root 必须是存在的目录绝对路径。
 *
 * @param {{root:string,out?:string,defaultName?:string}} input
 * @returns {{ok:true,root:string,dir:string,relativePath:string,absolutePath:string}
 *          |{ok:false,code:'OUTPUT_PATH_INVALID',message:string,details:object}}
 */
export function resolveCapturePath({ root, out, defaultName } = {}) {
  if (typeof root !== 'string' || root.trim() === '' || !isAbsolute(root)) {
    return pathInvalid('workspace root must be an absolute path', { reason: 'root_not_absolute' });
  }
  let canonicalRoot;
  try {
    const info = statSync(root);
    if (!info.isDirectory()) return pathInvalid('workspace root is not a directory', { reason: 'root_not_directory' });
    canonicalRoot = realpathSync(root);
  } catch {
    return pathInvalid('workspace root does not exist', { reason: 'root_unavailable' });
  }

  const requested = out === undefined || out === null ? defaultName : out;
  if (typeof requested !== 'string' || requested.trim() === '') {
    return pathInvalid('capture output path must be a non-empty string', { reason: 'out_missing' });
  }
  if (requested.includes('\0')) return pathInvalid('capture output path contains a NUL byte', { reason: 'out_nul' });
  if (requested.includes('\\')) {
    return pathInvalid('capture output path must use POSIX separators, not backslashes', { reason: 'out_backslash' });
  }
  if (/^[A-Za-z]:/.test(requested) || isAbsolute(requested) || requested.startsWith('//')) {
    return pathInvalid('capture output path must be relative to the workspace root', { reason: 'out_absolute' });
  }
  const byteLength = Buffer.byteLength(requested, 'utf8');
  if (byteLength > 200) {
    return pathInvalid('capture output path is longer than 200 bytes', { reason: 'out_too_long', byteLength });
  }
  const segments = requested.split('/');
  for (const segment of segments) {
    if (segment === '' || segment === '.' || segment === '..') {
      return pathInvalid('capture output path must not contain empty, "." or ".." segments', {
        reason: segment === '..' ? 'out_parent_segment' : 'out_empty_segment',
      });
    }
    if (Buffer.byteLength(segment, 'utf8') > 100) {
      return pathInvalid('capture output path has a path segment longer than 100 bytes', { reason: 'out_segment_too_long' });
    }
  }
  const name = segments[segments.length - 1];
  if (!name.endsWith('.png')) {
    return pathInvalid('capture output path must end with .png', { reason: 'out_not_png' });
  }

  const targetAbsolute = resolve(canonicalRoot, requested);
  if (!isInside(canonicalRoot, targetAbsolute)) {
    return pathInvalid('capture output path escapes the workspace root', { reason: 'out_escape' });
  }

  let dir;
  try {
    mkdirSync(dirname(targetAbsolute), { recursive: true });
    dir = realpathSync(dirname(targetAbsolute));
  } catch (error) {
    return pathInvalid('capture output directory cannot be created', {
      reason: 'dir_create_failed',
      code: error && error.code ? String(error.code) : null,
    });
  }
  if (!isInside(canonicalRoot, dir) && dir !== canonicalRoot) {
    return pathInvalid('capture output directory resolves outside the workspace root', { reason: 'dir_escape' });
  }

  const absolutePath = join(dir, basename(targetAbsolute));
  const relativePath = relative(canonicalRoot, absolutePath).split(sep).join('/');
  if (relativePath === '' || relativePath.startsWith('../') || relativePath === '..' || isAbsolute(relativePath)) {
    return pathInvalid('capture output path escapes the workspace root', { reason: 'out_escape' });
  }
  return { ok: true, root: canonicalRoot, dir, relativePath, absolutePath };
}

/** 目录 fsync：返回是否成功；失败只是“清理/持久化未确认”，不改变已提交文件的成功语义。 */
function fsyncDirectory(dir) {
  let fd;
  try {
    fd = openSync(dir, 'r');
    fsyncSync(fd);
    return true;
  } catch {
    return false;
  } finally {
    if (fd !== undefined) {
      try { closeSync(fd); } catch { /* ignore */ }
    }
  }
}

function writeFailed(message, details) {
  return { ok: false, code: 'OUTPUT_WRITE_FAILED', message, details };
}

/**
 * 原子且不覆盖地发布一个文件：同目录隐藏临时文件（O_EXCL、0600）写完 fsync ->
 * `link(temp, final)`（目标已存在时 EEXIST）-> 删临时文件 -> 目录 fsync（尽力而为）。
 *
 * **提交点 = `link(temp, final)` 成功那一刻**。此后 temp unlink / 目录 fsync 的失败只记进
 * `cleanup:{tempRemoved,dirFsync}` 并仍然返回成功：绝不因为清理失败改报错误，也绝不删除已发布文件。
 * 只有 link 之前的失败（写/文件 fsync/link 非 EEXIST 错误）才清理 temp 并返回失败。
 *
 * 既有目标文件一个字节都不会被改动；symlink 目标同样按已存在处理（EEXIST），
 * 不跟随、不覆盖。EEXIST 时只删临时文件，final 零改动。
 *
 * 边界：mkdir + realpath + link 防的是常规越界/覆盖，不声称抵抗“本地恶意进程在校验后并发替换父目录”
 * 的 TOCTOU，也不声称文件系统级安全隔离。
 *
 * @param {string} dir 目标目录（绝对路径）
 * @param {string} absolutePath 目标文件的绝对路径（必须与 dir 同目录）
 * @param {Uint8Array|Buffer} bytes
 * @param {{mode?:number}} [options]
 * @returns {{ok:true,path:string,bytes:number,createdAt:number,mode:string,
 *            cleanup:{tempRemoved:boolean,dirFsync:boolean}}
 *          |{ok:false,code:'OUTPUT_EXISTS'|'OUTPUT_WRITE_FAILED',message:string,details:object}}
 */
export function publishCapture(dir, absolutePath, bytes, { mode = 0o600 } = {}) {
  const name = typeof absolutePath === 'string' ? basename(absolutePath) : null;
  if (typeof dir !== 'string' || !isAbsolute(dir)) {
    return writeFailed('capture output directory must be an absolute path', { reason: 'dir_not_absolute' });
  }
  if (typeof absolutePath !== 'string' || !isAbsolute(absolutePath)) {
    return writeFailed('capture output path must be an absolute path', { reason: 'path_not_absolute' });
  }
  if (resolve(dirname(absolutePath)) !== resolve(dir)) {
    return writeFailed('capture output file must live in the capture output directory', {
      reason: 'cross_directory',
      name,
    });
  }
  const data = asBuffer(bytes);
  if (!data || data.length === 0) {
    return writeFailed('capture bytes are empty', { reason: 'empty_bytes', name });
  }
  const fileMode = Number.isInteger(mode) && mode > 0 && mode <= 0o777 ? mode : 0o600;
  const modeString = '0' + (fileMode & 0o777).toString(8).padStart(3, '0');
  const tempPath = join(dir, '.tmp-' + randomUUID() + '.png');

  let fd;
  try {
    fd = openSync(tempPath, 'wx', fileMode);
    writeSync(fd, data);
    fsyncSync(fd);
    closeSync(fd);
    fd = undefined;
  } catch (error) {
    if (fd !== undefined) {
      try { closeSync(fd); } catch { /* ignore */ }
    }
    try { unlinkSync(tempPath); } catch { /* ignore */ }
    return writeFailed('capture bytes could not be written to the output directory', {
      reason: 'temp_write_failed',
      code: error && error.code ? String(error.code) : null,
      name,
    });
  }

  try {
    linkSync(tempPath, absolutePath);
  } catch (error) {
    // link 失败 = 未提交：清理临时文件，final 一定没有被本次调用创建或改动。
    try { unlinkSync(tempPath); } catch { /* ignore */ }
    if (error && (error.code === 'EEXIST' || error.code === 'EISDIR')) {
      return {
        ok: false,
        code: 'OUTPUT_EXISTS',
        message: 'capture output already exists; this tool never overwrites it',
        details: { reason: 'output_exists', name },
      };
    }
    return writeFailed('capture file could not be published atomically', {
      reason: 'publish_failed',
      code: error && error.code ? String(error.code) : null,
      name,
    });
  }

  // ---- 提交点已过：以下清理的成败只记录，不改变结果，也不碰 final ----
  let tempRemoved = true;
  try { unlinkSync(tempPath); } catch { tempRemoved = false; }
  const dirFsync = fsyncDirectory(dir);
  return {
    ok: true,
    path: absolutePath,
    bytes: data.length,
    createdAt: Date.now(),
    mode: modeString,
    cleanup: { tempRemoved, dirFsync },
  };
}
