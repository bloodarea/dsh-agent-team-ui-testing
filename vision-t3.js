/**
 * vision-t3.js — WEB-T3 静态视觉的纯算法层（零 npm 依赖、无 CDP/浏览器代码）。
 *
 * 权威契约：docs/t3-vision.md（§1–§5、§9 的 U 类条目）；
 * 模块 API：docs/t3-implementation-plan.md §2.1/§2.3。
 *
 * 设计约束：
 *  - 只依赖 node:crypto / node:zlib 与既有 capture-p0.js（inspectPng/crc32）、browser-safety.js（BrowserError）。
 *  - 不 import CDP、不启动浏览器、不写文件、不读环境变量、无全局可变状态。
 *  - 失败：参数/预算/取消/尺寸/空比较一律抛 BrowserError；PNG 解码把格式/结构错误作为
 *    `{ok:false,code,message}` 返回（契约 §2.1 decodePngToRgba 形状），由调用方转抛。
 *  - 每 65,536 像素/比较检查一次取消与 5,000ms 算法预算；`*Async` 变体在检查点 await
 *    让出事件循环（同步变体在单次同步执行中无法投递 abort 事件，只能检查已 abort 的 signal
 *    与墙钟预算，Host 有取消需求时用 Async 变体）。
 *  - PNG 解码在 inflate 前用预期扫描行字节数限制输出（防压缩炸弹），channel 1/2/3/4 正规化 RGBA8。
 *
 * 实现约定（契约未逐字规定、此处固定并供 Host/验收引用）：
 *  - findInImage 返回的 candidates[].region / centroid 是**完整输入 image** 坐标（ROI 原点已回加）。
 *  - diffImages 返回 regions（≤100，id r1…）+ regionCount（过滤后总数）+ regionsTruncated；
 *    C=N-M=0 时抛 VISION_EMPTY_COMPARISON；highlight 是完整源图尺寸的 PNG Buffer。
 *  - VisionProductStore.pin() 找不到时返回 null（由调用方抛 VISION_SOURCE_NOT_FOUND）；
 *    add() 在未提供 sha256 时自算编码字节 hash，不自算 rgbaSha256（store 不长期持有解码缓冲）。
 *  - AA 3×3 排除：Y 相等计数在边界初值 1、内部 0；第二层「两图各有 ≥3 个相等 RGBA 邻居」按
 *    实际有效邻居计数（不再加初值），并列邻居按 y 后 x 升序取第一个。
 *  - 工作集预算在 diff 分配前按 16·W·H + 7·N + min(4·W·H, 32MiB) 估算（契约 §1.1 的
 *    「同时存活缓冲」口径），超限抛 VISION_LIMIT_EXCEEDED；其它操作由像素/字节硬上限兜底。
 */

import { createHash, randomBytes } from 'node:crypto';
import { constants as zlibConstants, deflateSync, inflateSync } from 'node:zlib';

import { BrowserError } from './browser-safety.js';
import { crc32, inspectPng } from './capture-p0.js';

/* ------------------------------------------------------------------ */
/* 常量                                                                */
/* ------------------------------------------------------------------ */

export const VISION_ALGORITHM_VERSION = 't3-v1';

export const VISION_LIMITS = Object.freeze({
  maxProducts: 16,
  maxTotalBytes: 128 * 1024 * 1024,
  maxProductBytes: 32 * 1024 * 1024,
  maxProductPixels: 16000000,
  maxWorkingSetBytes: 256 * 1024 * 1024,
  maxTemplateComparisons: 50000000,
  algorithmBudgetMs: 5000,
  maxOutputPixels: 16000000,
  maxOutputBytes: 32 * 1024 * 1024,
});

export const DEFAULT_DIFF_OPTIONS = Object.freeze({ threshold: 0.1, includeAA: false, minRegionPixels: 1 });
export const DEFAULT_THRESHOLDS = Object.freeze({ warnRatio: 0.001, failRatio: 0.01 });

export const WARNING_VOCABULARY = Object.freeze([
  'bitmap-upscaled',
  'mapping-incompatible',
  'advisory-only',
  'fact-unverified',
  'regions-truncated',
  'animation-not-evaluated',
]);

/** 每 65,536 像素/比较检查一次取消与算法预算。 */
const CHECKPOINT_UNITS = 65536;

/** PNG 编码固定参数（契约 §4.1）：RGBA8/type6、非交错、filter 0、level 9、单 IDAT、无 tIME。 */
const PNG_SIGNATURE = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);
const PNG_COLOR_TYPE_CHANNELS = Object.freeze({ 0: 1, 2: 3, 4: 2, 6: 4 });
const DEFLATE_OPTIONS = Object.freeze({
  level: 9,
  windowBits: 15,
  memLevel: 8,
  strategy: zlibConstants.Z_DEFAULT_STRATEGY,
});

const NAME_PATTERN = /^[a-zA-Z0-9][a-zA-Z0-9_-]{0,63}$/;
const PRODUCT_ID_PATTERN = /^v1_[0-9a-f]{32}$/;

const DIGIT_BITMAPS = Object.freeze({
  0: ['111', '101', '101', '101', '111'],
  1: ['010', '110', '010', '010', '111'],
  2: ['111', '001', '111', '100', '111'],
  3: ['111', '001', '111', '001', '111'],
  4: ['101', '101', '111', '001', '001'],
  5: ['111', '100', '111', '001', '111'],
  6: ['111', '100', '111', '101', '111'],
  7: ['111', '001', '010', '010', '010'],
  8: ['111', '101', '111', '101', '111'],
  9: ['111', '101', '111', '001', '111'],
});

/* ------------------------------------------------------------------ */
/* 错误、操作上下文、生成器驱动                                        */
/* ------------------------------------------------------------------ */

function visionLimitExceeded(limit, actual, max, message) {
  return new BrowserError('VISION_LIMIT_EXCEEDED', message || `vision 预算超限: ${limit}`, {
    limit,
    actual,
    max,
  });
}

function invalidArgument(path, reason, label) {
  const parts = [label, path].filter((part) => typeof part === 'string' && part !== '');
  const fullPath = parts.length ? parts.join('.') : 'value';
  return new BrowserError('INVALID_ARGUMENT', `参数不合法: ${fullPath} (${reason})`, {
    path: fullPath,
    reason,
  });
}

function createOpContext({ signal, budgetMs, startedAt } = {}) {
  const budget = Number.isFinite(budgetMs) && budgetMs >= 0 ? budgetMs : VISION_LIMITS.algorithmBudgetMs;
  return {
    signal: signal || null,
    budgetMs: budget,
    startedAt: Number.isFinite(startedAt) ? startedAt : Date.now(),
    check(operation) {
      if (this.signal && this.signal.aborted) {
        throw new BrowserError('ABORTED', 'vision 算法已取消', { operation });
      }
      const elapsedMs = Date.now() - this.startedAt;
      if (elapsedMs > this.budgetMs) {
        throw new BrowserError('VISION_TIMEOUT', 'vision 算法超出预算', {
          operation,
          budgetMs: this.budgetMs,
          elapsedMs,
        });
      }
    },
  };
}

function driveSync(generator, ctx, operation) {
  ctx.check(operation);
  let step = generator.next();
  while (!step.done) {
    ctx.check(operation);
    step = generator.next();
  }
  return step.value;
}

async function driveAsync(generator, ctx, operation) {
  ctx.check(operation);
  let step = generator.next();
  while (!step.done) {
    ctx.check(operation);
    await new Promise((resolve) => setImmediate(resolve));
    step = generator.next();
  }
  return step.value;
}

/* ------------------------------------------------------------------ */
/* 基础工具                                                            */
/* ------------------------------------------------------------------ */

function clampByte(value) {
  if (value < 0) return 0;
  if (value > 255) return 255;
  return value;
}

function clampInt(value, min, max) {
  if (value < min) return min;
  if (value > max) return max;
  return value;
}

function isPlainObject(value) {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function hasOwn(object, key) {
  return Object.prototype.hasOwnProperty.call(object, key);
}

function toBuffer(bytes) {
  if (Buffer.isBuffer(bytes)) return bytes;
  if (bytes instanceof Uint8Array) return Buffer.from(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  if (bytes instanceof ArrayBuffer) return Buffer.from(bytes);
  return null;
}

function sha256Hex(bytes) {
  return createHash('sha256').update(bytes).digest('hex');
}

function assertImage(image, label = 'image') {
  if (!isPlainObject(image)) throw invalidArgument('', 'invalid-image', label);
  const { width, height, rgba } = image;
  if (!Number.isInteger(width) || width <= 0) throw invalidArgument('width', 'invalid-dimensions', label);
  if (!Number.isInteger(height) || height <= 0) throw invalidArgument('height', 'invalid-dimensions', label);
  if (!(rgba instanceof Uint8Array)) throw invalidArgument('rgba', 'invalid-rgba-buffer', label);
  if (rgba.length !== width * height * 4) throw invalidArgument('rgba', 'invalid-rgba-buffer', label);
  return image;
}

function assertOutputPixels(pixels, label = 'image') {
  if (pixels > VISION_LIMITS.maxOutputPixels) {
    throw visionLimitExceeded(
      'maxOutputPixels',
      pixels,
      VISION_LIMITS.maxOutputPixels,
      `${label}: 输出像素超限`,
    );
  }
}

/* ------------------------------------------------------------------ */
/* 参数校验                                                            */
/* ------------------------------------------------------------------ */

function assertObject(value, label) {
  if (!isPlainObject(value)) throw invalidArgument('', 'not-an-object', label);
  return value;
}

function assertAllowedKeys(value, allowed, label) {
  for (const key of Object.keys(value)) {
    if (!allowed.includes(key)) throw invalidArgument(key, 'unknown-field', label);
  }
}

function readNumber(value, key, label, options = {}) {
  const { min, max, integer = false, required = false, fallback } = options;
  if (!hasOwn(value, key)) {
    if (required) throw invalidArgument(key, 'missing-required-field', label);
    return fallback;
  }
  const raw = value[key];
  if (typeof raw !== 'number' || !Number.isFinite(raw)) {
    throw invalidArgument(key, 'not-a-finite-number', label);
  }
  if (integer && !Number.isInteger(raw)) throw invalidArgument(key, 'not-an-integer', label);
  if (min !== undefined && raw < min) throw invalidArgument(key, 'below-minimum', label);
  if (max !== undefined && raw > max) throw invalidArgument(key, 'above-maximum', label);
  return raw;
}

function readBoolean(value, key, label, fallback) {
  if (!hasOwn(value, key)) return fallback;
  const raw = value[key];
  if (typeof raw !== 'boolean') throw invalidArgument(key, 'not-a-boolean', label);
  return raw;
}

function readName(value, key, label) {
  if (!hasOwn(value, key)) throw invalidArgument(key, 'missing-required-field', label);
  const raw = value[key];
  if (typeof raw !== 'string' || !NAME_PATTERN.test(raw)) throw invalidArgument(key, 'invalid-name', label);
  return raw;
}

function readString(value, key, label, { required = false, fallback = null, maxBytes = 200 } = {}) {
  if (!hasOwn(value, key)) {
    if (required) throw invalidArgument(key, 'missing-required-field', label);
    return fallback;
  }
  const raw = value[key];
  if (typeof raw !== 'string') throw invalidArgument(key, 'not-a-string', label);
  if (raw === '' || raw.trim() === '') throw invalidArgument(key, 'empty-string', label);
  if (Buffer.byteLength(raw, 'utf8') > maxBytes) throw invalidArgument(key, 'string-too-long', label);
  if (raw.includes('\0')) throw invalidArgument(key, 'string-has-nul', label);
  return raw;
}

function readColorArray(value, key, label, length) {
  if (!hasOwn(value, key)) throw invalidArgument(key, 'missing-required-field', label);
  const raw = value[key];
  if (!Array.isArray(raw) || raw.length !== length) {
    throw invalidArgument(key, `expected-rgba-array-${length}`, label);
  }
  const out = new Array(length);
  for (let index = 0; index < length; index += 1) {
    const channel = raw[index];
    if (!Number.isInteger(channel) || channel < 0 || channel > 255) {
      throw invalidArgument(`${key}[${index}]`, 'invalid-color-channel', label);
    }
    out[index] = channel;
  }
  return out;
}

function readOptionalColorArray(value, key, label, length, fallback) {
  if (!hasOwn(value, key)) return fallback;
  const raw = value[key];
  if (!Array.isArray(raw) || raw.length !== length) {
    throw invalidArgument(key, `expected-rgba-array-${length}`, label);
  }
  const out = new Array(length);
  for (let index = 0; index < length; index += 1) {
    const channel = raw[index];
    if (!Number.isInteger(channel) || channel < 0 || channel > 255) {
      throw invalidArgument(`${key}[${index}]`, 'invalid-color-channel', label);
    }
    out[index] = channel;
  }
  return out;
}

function validatePixelPoint(value, label) {
  const point = assertObject(value, label);
  assertAllowedKeys(point, ['x', 'y'], label);
  const x = readNumber(point, 'x', label, { min: 0, integer: true, required: true });
  const y = readNumber(point, 'y', label, { min: 0, integer: true, required: true });
  return { x, y };
}

export function validatePixelRect(value, label = 'rect') {
  const rect = assertObject(value, label);
  assertAllowedKeys(rect, ['x', 'y', 'width', 'height'], label);
  const x = readNumber(rect, 'x', label, { min: 0, integer: true, required: true });
  const y = readNumber(rect, 'y', label, { min: 0, integer: true, required: true });
  const width = readNumber(rect, 'width', label, { min: 1, integer: true, required: true });
  const height = readNumber(rect, 'height', label, { min: 1, integer: true, required: true });
  return { x, y, width, height };
}

export function validateCssRect(value, label = 'rect') {
  const rect = assertObject(value, label);
  assertAllowedKeys(rect, ['x', 'y', 'width', 'height'], label);
  const x = readNumber(rect, 'x', label, { min: 0, required: true });
  const y = readNumber(rect, 'y', label, { min: 0, required: true });
  const width = readNumber(rect, 'width', label, { min: 1, required: true });
  const height = readNumber(rect, 'height', label, { min: 1, required: true });
  return { x, y, width, height };
}

export function validatePoint(value, label = 'point') {
  const point = assertObject(value, label);
  assertAllowedKeys(point, ['x', 'y'], label);
  const x = readNumber(point, 'x', label, { min: 0, required: true });
  const y = readNumber(point, 'y', label, { min: 0, required: true });
  return { x, y };
}

export function validateSource(value, label = 'source') {
  if (value === undefined) return { kind: 'live', scale: 1 };
  const source = assertObject(value, label);
  const kind = source.kind;
  if (kind !== 'live' && kind !== 'product' && kind !== 'baseline') {
    throw invalidArgument('kind', hasOwn(source, 'kind') ? 'invalid-enum' : 'missing-required-field', label);
  }
  if (kind === 'live') {
    assertAllowedKeys(source, ['kind', 'scale', 'region'], label);
    const scale = readNumber(source, 'scale', label, { min: 1, max: 4, fallback: 1 });
    const normalized = { kind: 'live', scale };
    if (hasOwn(source, 'region')) normalized.region = validateCssRect(source.region, `${label}.region`);
    return normalized;
  }
  if (kind === 'product') {
    assertAllowedKeys(source, ['kind', 'productId'], label);
    if (!hasOwn(source, 'productId')) throw invalidArgument('productId', 'missing-required-field', label);
    const productId = source.productId;
    if (typeof productId !== 'string' || !PRODUCT_ID_PATTERN.test(productId)) {
      throw invalidArgument('productId', 'invalid-product-id', label);
    }
    return { kind: 'product', productId };
  }
  assertAllowedKeys(source, ['kind', 'name', 'revision'], label);
  const name = readName(source, 'name', label);
  const normalized = { kind: 'baseline', name };
  if (hasOwn(source, 'revision')) {
    normalized.revision = readNumber(source, 'revision', label, {
      min: 1,
      max: 9999999999,
      integer: true,
      required: true,
    });
  }
  return normalized;
}

export function validateQuery(value, label = 'query') {
  const query = assertObject(value, label);
  const method = query.method;
  const METHODS = ['color', 'components', 'edges', 'template'];
  if (!METHODS.includes(method)) {
    throw invalidArgument('method', hasOwn(query, 'method') ? 'invalid-enum' : 'missing-required-field', label);
  }
  const maxResults = readNumber(query, 'maxResults', label, { min: 1, max: 100, integer: true, fallback: 20 });
  if (method === 'template') {
    assertAllowedKeys(query, ['method', 'maxResults', 'template', 'minScore', 'stride'], label);
    if (!hasOwn(query, 'template')) throw invalidArgument('template', 'missing-required-field', label);
    const template = validateSource(query.template, `${label}.template`);
    if (template.kind === 'live') {
      throw invalidArgument('template', 'template-source-must-be-product-or-baseline', label);
    }
    const minScore = readNumber(query, 'minScore', label, { min: 0, max: 1, fallback: 0.95 });
    const stride = readNumber(query, 'stride', label, { min: 1, max: 16, integer: true, fallback: 1 });
    return { method, maxResults, template, minScore, stride };
  }
  assertAllowedKeys(query, ['method', 'minArea', 'maxResults', 'color', 'tolerance', 'background', 'edgeThreshold'], label);
  const minArea = readNumber(query, 'minArea', label, { min: 1, max: 16000000, integer: true, fallback: 4 });
  if (method === 'color') {
    assertAllowedKeys(query, ['method', 'minArea', 'maxResults', 'color', 'tolerance'], label);
    const color = readColorArray(query, 'color', label, 3);
    const tolerance = readNumber(query, 'tolerance', label, { min: 0, max: 255, integer: true, fallback: 16 });
    return { method, minArea, maxResults, color, tolerance };
  }
  if (method === 'components') {
    assertAllowedKeys(query, ['method', 'minArea', 'maxResults', 'background', 'tolerance'], label);
    const background = readOptionalColorArray(query, 'background', label, 3, [255, 255, 255]);
    const tolerance = readNumber(query, 'tolerance', label, { min: 0, max: 255, integer: true, fallback: 16 });
    return { method, minArea, maxResults, background, tolerance };
  }
  assertAllowedKeys(query, ['method', 'minArea', 'maxResults', 'edgeThreshold'], label);
  const edgeThreshold = readNumber(query, 'edgeThreshold', label, {
    min: 0,
    max: 255,
    integer: true,
    fallback: 32,
  });
  return { method, minArea, maxResults, edgeThreshold };
}

export function validateDiffOptions(value, label = 'options') {
  if (value === undefined) return { ...DEFAULT_DIFF_OPTIONS };
  const options = assertObject(value, label);
  assertAllowedKeys(options, ['threshold', 'includeAA', 'minRegionPixels'], label);
  const threshold = readNumber(options, 'threshold', label, {
    min: 0,
    max: 1,
    fallback: DEFAULT_DIFF_OPTIONS.threshold,
  });
  const includeAA = readBoolean(options, 'includeAA', label, DEFAULT_DIFF_OPTIONS.includeAA);
  const minRegionPixels = readNumber(options, 'minRegionPixels', label, {
    min: 1,
    max: 16000000,
    integer: true,
    fallback: DEFAULT_DIFF_OPTIONS.minRegionPixels,
  });
  return { threshold, includeAA, minRegionPixels };
}

export function validateThresholds(value, label = 'thresholds') {
  if (value === undefined) return { ...DEFAULT_THRESHOLDS };
  const thresholds = assertObject(value, label);
  assertAllowedKeys(thresholds, ['warnRatio', 'failRatio'], label);
  const warnRatio = readNumber(thresholds, 'warnRatio', label, {
    min: 0,
    max: 1,
    fallback: DEFAULT_THRESHOLDS.warnRatio,
  });
  const failRatio = readNumber(thresholds, 'failRatio', label, {
    min: 0,
    max: 1,
    fallback: DEFAULT_THRESHOLDS.failRatio,
  });
  if (warnRatio > failRatio) throw invalidArgument('failRatio', 'warn-ratio-greater-than-fail-ratio', label);
  return { warnRatio, failRatio };
}

export function validateMasks(value, label = 'masks') {
  if (value === undefined) return [];
  if (!Array.isArray(value)) throw invalidArgument('', 'not-an-array', label);
  if (value.length > 64) throw invalidArgument('', 'too-many-items', label);
  const seen = new Set();
  const masks = [];
  for (let index = 0; index < value.length; index += 1) {
    const itemLabel = `${label}[${index}]`;
    const mask = assertObject(value[index], itemLabel);
    assertAllowedKeys(mask, ['id', 'region'], itemLabel);
    const id = readName(mask, 'id', itemLabel);
    if (seen.has(id)) throw invalidArgument('id', 'duplicate-id', itemLabel);
    seen.add(id);
    if (!hasOwn(mask, 'region')) throw invalidArgument('region', 'missing-required-field', itemLabel);
    const region = validatePixelRect(mask.region, `${itemLabel}.region`);
    masks.push({ id, region });
  }
  return masks;
}

export function validateAnnotations(value, label = 'annotations') {
  if (value === undefined) return [];
  if (!Array.isArray(value)) throw invalidArgument('', 'not-an-array', label);
  if (value.length > 64) throw invalidArgument('', 'too-many-items', label);
  const annotations = [];
  for (let index = 0; index < value.length; index += 1) {
    const itemLabel = `${label}[${index}]`;
    const item = assertObject(value[index], itemLabel);
    const kind = item.kind;
    if (kind !== 'rect' && kind !== 'cross' && kind !== 'number' && kind !== 'arrow') {
      throw invalidArgument('kind', hasOwn(item, 'kind') ? 'invalid-enum' : 'missing-required-field', itemLabel);
    }
    const color = readOptionalColorArray(item, 'color', itemLabel, 4, [255, 0, 0, 255]);
    const thickness = readNumber(item, 'thickness', itemLabel, { min: 1, max: 8, integer: true, fallback: 2 });
    if (kind === 'rect') {
      assertAllowedKeys(item, ['kind', 'color', 'thickness', 'region'], itemLabel);
      if (!hasOwn(item, 'region')) throw invalidArgument('region', 'missing-required-field', itemLabel);
      const region = validatePixelRect(item.region, `${itemLabel}.region`);
      annotations.push({ kind, color, thickness, region });
    } else if (kind === 'cross') {
      assertAllowedKeys(item, ['kind', 'color', 'thickness', 'point', 'size'], itemLabel);
      if (!hasOwn(item, 'point')) throw invalidArgument('point', 'missing-required-field', itemLabel);
      const point = validatePixelPoint(item.point, `${itemLabel}.point`);
      const size = readNumber(item, 'size', itemLabel, { min: 3, max: 63, integer: true, fallback: 9 });
      annotations.push({ kind, color, thickness, point, size });
    } else if (kind === 'number') {
      assertAllowedKeys(item, ['kind', 'color', 'thickness', 'point', 'number'], itemLabel);
      if (!hasOwn(item, 'point')) throw invalidArgument('point', 'missing-required-field', itemLabel);
      const point = validatePixelPoint(item.point, `${itemLabel}.point`);
      const number = readNumber(item, 'number', itemLabel, { min: 1, max: 999, integer: true, required: true });
      annotations.push({ kind, color, thickness, point, number });
    } else {
      assertAllowedKeys(item, ['kind', 'color', 'thickness', 'point', 'to'], itemLabel);
      if (!hasOwn(item, 'point')) throw invalidArgument('point', 'missing-required-field', itemLabel);
      if (!hasOwn(item, 'to')) throw invalidArgument('to', 'missing-required-field', itemLabel);
      const point = validatePixelPoint(item.point, `${itemLabel}.point`);
      const to = validatePixelPoint(item.to, `${itemLabel}.to`);
      annotations.push({ kind, color, thickness, point, to });
    }
  }
  return annotations;
}

export function validatePreprocess(value, label = 'preprocess') {
  if (value === undefined) return [];
  if (!Array.isArray(value)) throw invalidArgument('', 'not-an-array', label);
  if (value.length > 8) throw invalidArgument('', 'too-many-items', label);
  const ops = [];
  for (let index = 0; index < value.length; index += 1) {
    const itemLabel = `${label}[${index}]`;
    const item = assertObject(value[index], itemLabel);
    const op = item.op;
    if (op !== 'grayscale' && op !== 'blur' && op !== 'normalize' && op !== 'threshold' && op !== 'channels') {
      throw invalidArgument('op', hasOwn(item, 'op') ? 'invalid-enum' : 'missing-required-field', itemLabel);
    }
    if (op === 'blur') {
      assertAllowedKeys(item, ['op', 'radius'], itemLabel);
      const radius = readNumber(item, 'radius', itemLabel, { min: 1, max: 3, integer: true, fallback: 1 });
      ops.push({ op, radius });
    } else if (op === 'threshold') {
      assertAllowedKeys(item, ['op', 'value'], itemLabel);
      const thresholdValue = readNumber(item, 'value', itemLabel, { min: 0, max: 255, integer: true, fallback: 128 });
      ops.push({ op, value: thresholdValue });
    } else if (op === 'channels') {
      assertAllowedKeys(item, ['op', 'order'], itemLabel);
      const order = hasOwn(item, 'order') ? item.order : 'rgba';
      if (order !== 'rgba' && order !== 'bgra' && order !== 'argb') {
        throw invalidArgument('order', 'invalid-enum', itemLabel);
      }
      ops.push({ op, order });
    } else {
      assertAllowedKeys(item, ['op'], itemLabel);
      ops.push({ op });
    }
  }
  return ops;
}

export function validateOutput(value, label = 'output') {
  if (value === undefined) return { persist: false };
  const output = assertObject(value, label);
  assertAllowedKeys(output, ['persist', 'out'], label);
  const persist = readBoolean(output, 'persist', label, false);
  const normalized = { persist };
  if (hasOwn(output, 'out')) {
    normalized.out = readString(output, 'out', label, { required: true, maxBytes: 200 });
  }
  return normalized;
}

/* ------------------------------------------------------------------ */
/* PNG 解码（8-bit、color type 0/2/4/6、非交错，正规化 RGBA8）          */
/* ------------------------------------------------------------------ */

function pngFailure(code, message, details) {
  return details ? { ok: false, code, message, details } : { ok: false, code, message };
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

function* decodePngSteps(bytes, ctx) {
  const inspected = inspectPng(bytes);
  if (!inspected.ok) return pngFailure('INVALID_PNG', 'PNG 结构或 CRC 校验失败');
  const buf = toBuffer(bytes);
  if (!buf) return pngFailure('INVALID_PNG', 'PNG 字节不可读');
  const bitDepth = buf[24];
  const colorType = buf[25];
  const compressionMethod = buf[26];
  const filterMethod = buf[27];
  const interlace = buf[28];
  if (bitDepth !== 8) {
    return pngFailure('VISION_FORMAT_UNSUPPORTED', 'PNG 位深不受支持（仅 8-bit）');
  }
  const channels = PNG_COLOR_TYPE_CHANNELS[colorType];
  if (!channels) {
    return pngFailure('VISION_FORMAT_UNSUPPORTED', 'PNG color type 不受支持（仅 0/2/4/6）');
  }
  if (interlace !== 0) return pngFailure('VISION_FORMAT_UNSUPPORTED', 'PNG 交错模式不受支持');
  if (compressionMethod !== 0 || filterMethod !== 0) {
    return pngFailure('VISION_FORMAT_UNSUPPORTED', 'PNG 压缩/滤波方法不受支持');
  }

  const width = inspected.width;
  const height = inspected.height;
  const pixels = width * height;
  if (pixels > VISION_LIMITS.maxProductPixels) {
    return pngFailure('VISION_LIMIT_EXCEEDED', 'PNG 像素数超过 product 上限', {
      limit: 'maxProductPixels',
      actual: pixels,
      max: VISION_LIMITS.maxProductPixels,
    });
  }

  const idatParts = [];
  let offset = 8;
  while (offset + 8 <= buf.length) {
    const length = buf.readUInt32BE(offset);
    const type = buf.toString('latin1', offset + 4, offset + 8);
    if (type === 'tRNS') {
      // 不支持调色板/透明块：不能忽略后把非 alpha 通道当不透明图分析。
      return pngFailure('VISION_FORMAT_UNSUPPORTED', 'PNG tRNS 透明度块不受支持');
    }
    if (type === 'IDAT') idatParts.push(buf.subarray(offset + 8, offset + 8 + length));
    offset += 8 + length + 4;
    if (type === 'IEND') break;
  }
  if (!idatParts.length) return pngFailure('INVALID_PNG', 'PNG 缺少 IDAT');

  const stride = width * channels;
  const expectedLength = (stride + 1) * height;
  let raw;
  try {
    raw = inflateSync(Buffer.concat(idatParts), { maxOutputLength: expectedLength });
  } catch {
    return pngFailure('INVALID_PNG', 'PNG IDAT 解压失败或超过预期扫描行长度（疑似压缩炸弹）');
  }
  if (raw.length !== expectedLength) {
    return pngFailure('INVALID_PNG', 'PNG 扫描行字节数与 IHDR 不一致');
  }

  const rgba = new Uint8Array(pixels * 4);
  let prev = new Uint8Array(stride);
  let cur = new Uint8Array(stride);
  let nextCheckpoint = CHECKPOINT_UNITS;
  for (let y = 0; y < height; y += 1) {
    const rowStart = y * (stride + 1);
    const filter = raw[rowStart];
    if (filter > 4) return pngFailure('INVALID_PNG', 'PNG 行 filter 类型非法');
    const inStart = rowStart + 1;
    for (let i = 0; i < stride; i += 1) {
      const x = raw[inStart + i];
      const left = i >= channels ? cur[i - channels] : 0;
      const up = y > 0 ? prev[i] : 0;
      const upLeft = y > 0 && i >= channels ? prev[i - channels] : 0;
      let value;
      switch (filter) {
        case 0: value = x; break;
        case 1: value = x + left; break;
        case 2: value = x + up; break;
        case 3: value = x + ((left + up) >> 1); break;
        default: value = x + paethPredictor(left, up, upLeft); break;
      }
      cur[i] = value & 0xff;
    }
    const outBase = y * width * 4;
    if (channels === 4) {
      rgba.set(cur, outBase);
    } else if (channels === 1) {
      for (let x = 0; x < width; x += 1) {
        const gray = cur[x];
        const out = outBase + x * 4;
        rgba[out] = gray;
        rgba[out + 1] = gray;
        rgba[out + 2] = gray;
        rgba[out + 3] = 255;
      }
    } else if (channels === 2) {
      for (let x = 0; x < width; x += 1) {
        const gray = cur[x * 2];
        const out = outBase + x * 4;
        rgba[out] = gray;
        rgba[out + 1] = gray;
        rgba[out + 2] = gray;
        rgba[out + 3] = cur[x * 2 + 1];
      }
    } else {
      for (let x = 0; x < width; x += 1) {
        const out = outBase + x * 4;
        const src = x * 3;
        rgba[out] = cur[src];
        rgba[out + 1] = cur[src + 1];
        rgba[out + 2] = cur[src + 2];
        rgba[out + 3] = 255;
      }
    }
    const tmp = prev;
    prev = cur;
    cur = tmp;
    const done = (y + 1) * width;
    if (done >= nextCheckpoint) {
      nextCheckpoint += CHECKPOINT_UNITS;
      yield;
    }
  }
  return { ok: true, width, height, rgba };
}

/** 解码 PNG 为 RGBA8：`{ok:true,width,height,rgba}` 或 `{ok:false,code,message[,details]}`。 */
export function decodePngToRgba(bytes, options = {}) {
  const ctx = createOpContext(options);
  return driveSync(decodePngSteps(bytes, ctx), ctx, 'decode');
}

/** decodePngToRgba 的让出事件循环版本（每 65,536 像素）。 */
export async function decodePngToRgbaAsync(bytes, options = {}) {
  const ctx = createOpContext(options);
  return driveAsync(decodePngSteps(bytes, ctx), ctx, 'decode');
}

/* ------------------------------------------------------------------ */
/* PNG 编码（RGBA8/type6、非交错、filter 0、level 9、单 IDAT、无 tIME） */
/* ------------------------------------------------------------------ */

function pngChunk(type, data) {
  const length = Buffer.alloc(4);
  length.writeUInt32BE(data.length, 0);
  const typeBytes = Buffer.from(type, 'latin1');
  const body = Buffer.concat([typeBytes, data]);
  const crc = Buffer.alloc(4);
  crc.writeUInt32BE(crc32(body) >>> 0, 0);
  return Buffer.concat([length, body, crc]);
}

function* encodePngSteps(image, ctx) {
  if (!isPlainObject(image)) throw invalidArgument('', 'invalid-image', 'image');
  const width = image.width;
  const height = image.height;
  if (!Number.isInteger(width) || width <= 0) throw invalidArgument('width', 'invalid-dimensions', 'image');
  if (!Number.isInteger(height) || height <= 0) throw invalidArgument('height', 'invalid-dimensions', 'image');
  const pixels = width * height;
  if (pixels > VISION_LIMITS.maxOutputPixels) {
    throw visionLimitExceeded(
      'maxOutputPixels',
      pixels,
      VISION_LIMITS.maxOutputPixels,
      'PNG 编码输出像素超限',
    );
  }
  const rgba = image.rgba;
  if (!(rgba instanceof Uint8Array) || rgba.length !== pixels * 4) {
    throw invalidArgument('rgba', 'invalid-rgba-buffer', 'image');
  }

  const rowBytes = width * 4;
  const raw = Buffer.allocUnsafe((rowBytes + 1) * height);
  let out = 0;
  let nextCheckpoint = CHECKPOINT_UNITS;
  for (let y = 0; y < height; y += 1) {
    raw[out] = 0;
    out += 1;
    raw.set(rgba.subarray(y * rowBytes, (y + 1) * rowBytes), out);
    out += rowBytes;
    const done = (y + 1) * width;
    if (done >= nextCheckpoint) {
      nextCheckpoint += CHECKPOINT_UNITS;
      yield;
    }
  }
  const compressed = deflateSync(raw, DEFLATE_OPTIONS);
  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(width, 0);
  ihdr.writeUInt32BE(height, 4);
  ihdr[8] = 8;
  ihdr[9] = 6;
  ihdr[10] = 0;
  ihdr[11] = 0;
  ihdr[12] = 0;
  const png = Buffer.concat([
    PNG_SIGNATURE,
    pngChunk('IHDR', ihdr),
    pngChunk('IDAT', compressed),
    pngChunk('IEND', Buffer.alloc(0)),
  ]);
  if (png.length > VISION_LIMITS.maxOutputBytes) {
    throw visionLimitExceeded('maxOutputBytes', png.length, VISION_LIMITS.maxOutputBytes, 'PNG 编码字节超限');
  }
  return png;
}

/** 编码 RGBA8 为确定性 PNG（固定 filter0/level9/单 IDAT/无 tIME），返回 Buffer。 */
export function encodePngRgba(image, options = {}) {
  const ctx = createOpContext(options);
  return driveSync(encodePngSteps(image, ctx), ctx, 'encode');
}

/** encodePngRgba 的让出事件循环版本。 */
export async function encodePngRgbaAsync(image, options = {}) {
  const ctx = createOpContext(options);
  return driveAsync(encodePngSteps(image, ctx), ctx, 'encode');
}

/* ------------------------------------------------------------------ */
/* 裁剪 / 缩放                                                         */
/* ------------------------------------------------------------------ */

function* cropSteps(image, rect, ctx) {
  assertImage(image, 'image');
  const region = validatePixelRect(rect, 'rect');
  if (region.x + region.width > image.width || region.y + region.height > image.height) {
    throw invalidArgument('rect', 'out-of-bounds', 'cropImage');
  }
  const pixels = region.width * region.height;
  assertOutputPixels(pixels, 'cropImage');
  const out = new Uint8Array(pixels * 4);
  const rowBytes = region.width * 4;
  let nextCheckpoint = CHECKPOINT_UNITS;
  for (let y = 0; y < region.height; y += 1) {
    const srcStart = ((region.y + y) * image.width + region.x) * 4;
    out.set(image.rgba.subarray(srcStart, srcStart + rowBytes), y * rowBytes);
    const done = (y + 1) * region.width;
    if (done >= nextCheckpoint) {
      nextCheckpoint += CHECKPOINT_UNITS;
      yield;
    }
  }
  return { width: region.width, height: region.height, rgba: out };
}

/** 裁剪（rect 必须完全在图内，左闭右开）。 */
export function cropImage(image, rect, options = {}) {
  const ctx = createOpContext(options);
  return driveSync(cropSteps(image, rect, ctx), ctx, 'crop');
}

/** cropImage 的让出事件循环版本。 */
export async function cropImageAsync(image, rect, options = {}) {
  const ctx = createOpContext(options);
  return driveAsync(cropSteps(image, rect, ctx), ctx, 'crop');
}

function readResizeFactor(factor) {
  if (typeof factor !== 'number' || !Number.isFinite(factor)) {
    throw invalidArgument('factor', 'not-a-finite-number', 'resize');
  }
  if (factor < 1 || factor > 4) throw invalidArgument('factor', 'out-of-range', 'resize');
  return factor;
}

function readResizeMethod(method) {
  if (method === undefined || method === null) return 'nearest';
  if (method !== 'nearest' && method !== 'bilinear') throw invalidArgument('method', 'invalid-enum', 'resize');
  return method;
}

function* resizeSteps(image, factor, method, ctx) {
  assertImage(image, 'image');
  const scale = readResizeFactor(factor);
  const algorithm = readResizeMethod(method);
  const widthOut = Math.round(image.width * scale);
  const heightOut = Math.round(image.height * scale);
  if (widthOut < 1 || heightOut < 1) throw invalidArgument('factor', 'empty-output', 'resize');
  assertOutputPixels(widthOut * heightOut, 'resizeImage');
  const out = new Uint8Array(widthOut * heightOut * 4);
  const widthIn = image.width;
  const heightIn = image.height;
  const rgba = image.rgba;
  let nextCheckpoint = CHECKPOINT_UNITS;

  if (algorithm === 'nearest') {
    for (let oy = 0; oy < heightOut; oy += 1) {
      const iy = Math.min(heightIn - 1, Math.floor(((oy + 0.5) * heightIn) / heightOut));
      const srcRow = iy * widthIn * 4;
      const dstRow = oy * widthOut * 4;
      for (let ox = 0; ox < widthOut; ox += 1) {
        const ix = Math.min(widthIn - 1, Math.floor(((ox + 0.5) * widthIn) / widthOut));
        const src = srcRow + ix * 4;
        const dst = dstRow + ox * 4;
        out[dst] = rgba[src];
        out[dst + 1] = rgba[src + 1];
        out[dst + 2] = rgba[src + 2];
        out[dst + 3] = rgba[src + 3];
      }
      const done = (oy + 1) * widthOut;
      if (done >= nextCheckpoint) {
        nextCheckpoint += CHECKPOINT_UNITS;
        yield;
      }
    }
    return { width: widthOut, height: heightOut, rgba: out };
  }

  // bilinear：u=(ox+0.5)*Win/Wout-0.5，四个相邻 clamp 像素按距离权重插值预乘 alpha。
  const x0 = new Int32Array(widthOut);
  const x1 = new Int32Array(widthOut);
  const fx = new Float64Array(widthOut);
  for (let ox = 0; ox < widthOut; ox += 1) {
    const u = ((ox + 0.5) * widthIn) / widthOut - 0.5;
    const base = Math.floor(u);
    x0[ox] = clampInt(base, 0, widthIn - 1);
    x1[ox] = clampInt(base + 1, 0, widthIn - 1);
    fx[ox] = u - base;
  }
  const y0 = new Int32Array(heightOut);
  const y1 = new Int32Array(heightOut);
  const fy = new Float64Array(heightOut);
  for (let oy = 0; oy < heightOut; oy += 1) {
    const v = ((oy + 0.5) * heightIn) / heightOut - 0.5;
    const base = Math.floor(v);
    y0[oy] = clampInt(base, 0, heightIn - 1);
    y1[oy] = clampInt(base + 1, 0, heightIn - 1);
    fy[oy] = v - base;
  }
  for (let oy = 0; oy < heightOut; oy += 1) {
    const row0 = y0[oy] * widthIn * 4;
    const row1 = y1[oy] * widthIn * 4;
    const wy1 = fy[oy];
    const wy0 = 1 - wy1;
    const dstRow = oy * widthOut * 4;
    for (let ox = 0; ox < widthOut; ox += 1) {
      const col0 = x0[ox] * 4;
      const col1 = x1[ox] * 4;
      const wx1 = fx[ox];
      const wx0 = 1 - wx1;
      const p00 = row0 + col0;
      const p01 = row0 + col1;
      const p10 = row1 + col0;
      const p11 = row1 + col1;
      const w00 = wx0 * wy0;
      const w01 = wx1 * wy0;
      const w10 = wx0 * wy1;
      const w11 = wx1 * wy1;
      const a00 = rgba[p00 + 3];
      const a01 = rgba[p01 + 3];
      const a10 = rgba[p10 + 3];
      const a11 = rgba[p11 + 3];
      const aSum = w00 * a00 + w01 * a01 + w10 * a10 + w11 * a11;
      const dst = dstRow + ox * 4;
      if (aSum <= 0) {
        out[dst] = 0;
        out[dst + 1] = 0;
        out[dst + 2] = 0;
        out[dst + 3] = 0;
      } else {
        out[dst] = clampByte(Math.round(
          (w00 * a00 * rgba[p00] + w01 * a01 * rgba[p01] + w10 * a10 * rgba[p10] + w11 * a11 * rgba[p11]) / aSum,
        ));
        out[dst + 1] = clampByte(Math.round(
          (w00 * a00 * rgba[p00 + 1] + w01 * a01 * rgba[p01 + 1] + w10 * a10 * rgba[p10 + 1] + w11 * a11 * rgba[p11 + 1]) / aSum,
        ));
        out[dst + 2] = clampByte(Math.round(
          (w00 * a00 * rgba[p00 + 2] + w01 * a01 * rgba[p01 + 2] + w10 * a10 * rgba[p10 + 2] + w11 * a11 * rgba[p11 + 2]) / aSum,
        ));
        out[dst + 3] = clampByte(Math.round(aSum));
      }
    }
    const done = (oy + 1) * widthOut;
    if (done >= nextCheckpoint) {
      nextCheckpoint += CHECKPOINT_UNITS;
      yield;
    }
  }
  return { width: widthOut, height: heightOut, rgba: out };
}

/** 位图缩放：factor∈[1,4]，method 'nearest'|'bilinear'（bilinear 预乘 alpha）。 */
export function resizeImage(image, factor, method, options = {}) {
  const ctx = createOpContext(options);
  return driveSync(resizeSteps(image, factor, method, ctx), ctx, 'resize');
}

/** resizeImage 的让出事件循环版本。 */
export async function resizeImageAsync(image, factor, method, options = {}) {
  const ctx = createOpContext(options);
  return driveAsync(resizeSteps(image, factor, method, ctx), ctx, 'resize');
}

/* ------------------------------------------------------------------ */
/* 预处理（grayscale/blur/normalize/threshold/channels，按列表顺序）    */
/* ------------------------------------------------------------------ */

function* grayscaleInPlace(rgba, pixels, ctx) {
  let nextCheckpoint = CHECKPOINT_UNITS;
  for (let index = 0; index < pixels; index += 1) {
    const offset = index * 4;
    const gray = clampByte(Math.round(0.299 * rgba[offset] + 0.587 * rgba[offset + 1] + 0.114 * rgba[offset + 2]));
    rgba[offset] = gray;
    rgba[offset + 1] = gray;
    rgba[offset + 2] = gray;
    if (index + 1 >= nextCheckpoint) {
      nextCheckpoint += CHECKPOINT_UNITS;
      yield;
    }
  }
}

function* blurInPlace(rgba, width, height, radius, ctx) {
  const src = new Uint8Array(rgba);
  const windowCount = (2 * radius + 1) * (2 * radius + 1);
  let nextCheckpoint = CHECKPOINT_UNITS;
  for (let y = 0; y < height; y += 1) {
    for (let x = 0; x < width; x += 1) {
      let sumA = 0;
      let sumR = 0;
      let sumG = 0;
      let sumB = 0;
      for (let dy = -radius; dy <= radius; dy += 1) {
        const sy = clampInt(y + dy, 0, height - 1);
        for (let dx = -radius; dx <= radius; dx += 1) {
          const sx = clampInt(x + dx, 0, width - 1);
          const offset = (sy * width + sx) * 4;
          const alpha = src[offset + 3];
          sumA += alpha;
          sumR += src[offset] * alpha;
          sumG += src[offset + 1] * alpha;
          sumB += src[offset + 2] * alpha;
        }
      }
      const offset = (y * width + x) * 4;
      if (sumA <= 0) {
        rgba[offset] = 0;
        rgba[offset + 1] = 0;
        rgba[offset + 2] = 0;
        rgba[offset + 3] = 0;
      } else {
        rgba[offset] = clampByte(Math.round(sumR / sumA));
        rgba[offset + 1] = clampByte(Math.round(sumG / sumA));
        rgba[offset + 2] = clampByte(Math.round(sumB / sumA));
        rgba[offset + 3] = clampByte(Math.round(sumA / windowCount));
      }
    }
    const done = (y + 1) * width;
    if (done >= nextCheckpoint) {
      nextCheckpoint += CHECKPOINT_UNITS;
      yield;
    }
  }
}

function* normalizeInPlace(rgba, pixels, ctx) {
  let minR = 255;
  let maxR = 0;
  let minG = 255;
  let maxG = 0;
  let minB = 255;
  let maxB = 0;
  let anyOpaque = false;
  for (let index = 0; index < pixels; index += 1) {
    const offset = index * 4;
    if (rgba[offset + 3] === 0) continue;
    anyOpaque = true;
    const r = rgba[offset];
    const g = rgba[offset + 1];
    const b = rgba[offset + 2];
    if (r < minR) minR = r;
    if (r > maxR) maxR = r;
    if (g < minG) minG = g;
    if (g > maxG) maxG = g;
    if (b < minB) minB = b;
    if (b > maxB) maxB = b;
  }
  if (!anyOpaque) return;
  const rangeR = maxR - minR;
  const rangeG = maxG - minG;
  const rangeB = maxB - minB;
  let nextCheckpoint = CHECKPOINT_UNITS;
  for (let index = 0; index < pixels; index += 1) {
    const offset = index * 4;
    if (rgba[offset + 3] !== 0) {
      if (rangeR !== 0) rgba[offset] = clampByte(Math.round((255 * (rgba[offset] - minR)) / rangeR));
      if (rangeG !== 0) rgba[offset + 1] = clampByte(Math.round((255 * (rgba[offset + 1] - minG)) / rangeG));
      if (rangeB !== 0) rgba[offset + 2] = clampByte(Math.round((255 * (rgba[offset + 2] - minB)) / rangeB));
    }
    if (index + 1 >= nextCheckpoint) {
      nextCheckpoint += CHECKPOINT_UNITS;
      yield;
    }
  }
}

function* thresholdInPlace(rgba, pixels, value, ctx) {
  let nextCheckpoint = CHECKPOINT_UNITS;
  for (let index = 0; index < pixels; index += 1) {
    const offset = index * 4;
    const gray = Math.round(0.299 * rgba[offset] + 0.587 * rgba[offset + 1] + 0.114 * rgba[offset + 2]);
    const binary = gray >= value ? 255 : 0;
    rgba[offset] = binary;
    rgba[offset + 1] = binary;
    rgba[offset + 2] = binary;
    if (index + 1 >= nextCheckpoint) {
      nextCheckpoint += CHECKPOINT_UNITS;
      yield;
    }
  }
}

function* channelsInPlace(rgba, pixels, order, ctx) {
  if (order === 'rgba') return;
  let nextCheckpoint = CHECKPOINT_UNITS;
  for (let index = 0; index < pixels; index += 1) {
    const offset = index * 4;
    const r = rgba[offset];
    const g = rgba[offset + 1];
    const b = rgba[offset + 2];
    const a = rgba[offset + 3];
    if (order === 'bgra') {
      rgba[offset] = b;
      rgba[offset + 1] = g;
      rgba[offset + 2] = r;
      rgba[offset + 3] = a;
    } else {
      // argb: 输出 [a,r,g,b]
      rgba[offset] = a;
      rgba[offset + 1] = r;
      rgba[offset + 2] = g;
      rgba[offset + 3] = b;
    }
    if (index + 1 >= nextCheckpoint) {
      nextCheckpoint += CHECKPOINT_UNITS;
      yield;
    }
  }
}

function* preprocessSteps(image, ops, ctx) {
  assertImage(image, 'image');
  const list = validatePreprocess(ops === null ? undefined : ops, 'preprocess');
  const width = image.width;
  const height = image.height;
  const pixels = width * height;
  const rgba = new Uint8Array(image.rgba);
  for (const op of list) {
    if (op.op === 'grayscale') yield* grayscaleInPlace(rgba, pixels, ctx);
    else if (op.op === 'blur') yield* blurInPlace(rgba, width, height, op.radius, ctx);
    else if (op.op === 'normalize') yield* normalizeInPlace(rgba, pixels, ctx);
    else if (op.op === 'threshold') yield* thresholdInPlace(rgba, pixels, op.value, ctx);
    else yield* channelsInPlace(rgba, pixels, op.order, ctx);
  }
  return { width, height, rgba };
}

/** 预处理：ops 顺序生效，返回新 Image（不修改输入）。 */
export function preprocessImage(image, ops, options = {}) {
  const ctx = createOpContext(options);
  return driveSync(preprocessSteps(image, ops, ctx), ctx, 'preprocess');
}

/** preprocessImage 的让出事件循环版本。 */
export async function preprocessImageAsync(image, ops, options = {}) {
  const ctx = createOpContext(options);
  return driveAsync(preprocessSteps(image, ops, ctx), ctx, 'preprocess');
}

/* ------------------------------------------------------------------ */
/* 标注（rect/cross/number/arrow，整数像素 raster，无字体依赖）         */
/* ------------------------------------------------------------------ */

function compositeSourceOver(rgba, offset, color) {
  const srcA = color[3] / 255;
  const dstA = rgba[offset + 3] / 255;
  const outA = srcA + dstA * (1 - srcA);
  if (outA <= 0) {
    rgba[offset] = 0;
    rgba[offset + 1] = 0;
    rgba[offset + 2] = 0;
    rgba[offset + 3] = 0;
    return;
  }
  rgba[offset] = clampByte(Math.round((color[0] * srcA + rgba[offset] * dstA * (1 - srcA)) / outA));
  rgba[offset + 1] = clampByte(Math.round((color[1] * srcA + rgba[offset + 1] * dstA * (1 - srcA)) / outA));
  rgba[offset + 2] = clampByte(Math.round((color[2] * srcA + rgba[offset + 2] * dstA * (1 - srcA)) / outA));
  rgba[offset + 3] = clampByte(Math.round(outA * 255));
}

function brushOffsets(thickness) {
  const negative = Math.floor((thickness - 1) / 2);
  const positive = thickness - 1 - negative;
  return { negative, positive };
}

function* annotateSteps(image, annotations, ctx) {
  assertImage(image, 'image');
  const list = validateAnnotations(annotations === null ? undefined : annotations, 'annotations');
  const width = image.width;
  const height = image.height;
  const rgba = new Uint8Array(image.rgba);
  if (!list.length) return { width, height, rgba };

  const mask = new Uint8Array(width * height);
  const touched = [];
  let paintedSinceCheck = 0;

  const paint = (x, y) => {
    if (x < 0 || y < 0 || x >= width || y >= height) return;
    const index = y * width + x;
    if (mask[index]) return;
    mask[index] = 1;
    touched.push(index);
    paintedSinceCheck += 1;
  };

  for (const annotation of list) {
    const { negative, positive } = brushOffsets(annotation.thickness);
    touched.length = 0;
    paintedSinceCheck = 0;

    // 方形笔刷：以线中心向两侧扩张，偶数厚度多余像素放正方向（x/y 两个轴同规则）。
    const paintBrush = (x, y) => {
      for (let by = -negative; by <= positive; by += 1) {
        for (let bx = -negative; bx <= positive; bx += 1) paint(x + bx, y + by);
      }
    };

    if (annotation.kind === 'rect') {
      const region = annotation.region;
      if (region.x + region.width > width || region.y + region.height > height) {
        throw invalidArgument('region', 'out-of-bounds', 'annotateImage');
      }
      const right = region.x + region.width - 1;
      const bottom = region.y + region.height - 1;
      for (let x = region.x; x <= right; x += 1) {
        paintBrush(x, region.y);
        paintBrush(x, bottom);
        if (paintedSinceCheck >= CHECKPOINT_UNITS) {
          paintedSinceCheck = 0;
          yield;
        }
      }
      for (let y = region.y; y <= bottom; y += 1) {
        paintBrush(region.x, y);
        paintBrush(right, y);
        if (paintedSinceCheck >= CHECKPOINT_UNITS) {
          paintedSinceCheck = 0;
          yield;
        }
      }
    } else if (annotation.kind === 'cross') {
      const point = annotation.point;
      if (point.x >= width || point.y >= height) {
        throw invalidArgument('point', 'out-of-bounds', 'annotateImage');
      }
      const half = Math.floor((annotation.size - 1) / 2);
      const startX = point.x - half;
      const endX = startX + annotation.size - 1;
      const startY = point.y - half;
      const endY = startY + annotation.size - 1;
      for (let x = startX; x <= endX; x += 1) {
        paintBrush(x, point.y);
        if (paintedSinceCheck >= CHECKPOINT_UNITS) {
          paintedSinceCheck = 0;
          yield;
        }
      }
      for (let y = startY; y <= endY; y += 1) {
        paintBrush(point.x, y);
        if (paintedSinceCheck >= CHECKPOINT_UNITS) {
          paintedSinceCheck = 0;
          yield;
        }
      }
    } else if (annotation.kind === 'number') {
      const point = annotation.point;
      if (point.x >= width || point.y >= height) {
        throw invalidArgument('point', 'out-of-bounds', 'annotateImage');
      }
      const digits = String(annotation.number);
      for (let digitIndex = 0; digitIndex < digits.length; digitIndex += 1) {
        const bitmap = DIGIT_BITMAPS[digits[digitIndex]];
        const originX = point.x + digitIndex * 7; // 3×5 位图 2 倍 nearest = 6px，字间 1px
        for (let row = 0; row < 5; row += 1) {
          for (let col = 0; col < 3; col += 1) {
            if (bitmap[row][col] !== '1') continue;
            const px = originX + col * 2;
            const py = point.y + row * 2;
            paint(px, py);
            paint(px + 1, py);
            paint(px, py + 1);
            paint(px + 1, py + 1);
          }
        }
      }
    } else {
      const point = annotation.point;
      const to = annotation.to;
      if (point.x >= width || point.y >= height || to.x >= width || to.y >= height) {
        throw invalidArgument('to', 'out-of-bounds', 'annotateImage');
      }
      const drawLine = function* drawLine(x0, y0, x1, y1) {
        let cx = x0;
        let cy = y0;
        const dx = Math.abs(x1 - x0);
        const sx = x0 < x1 ? 1 : -1;
        const dy = -Math.abs(y1 - y0);
        const sy = y0 < y1 ? 1 : -1;
        let err = dx + dy;
        for (;;) {
          paintBrush(cx, cy);
          if (paintedSinceCheck >= CHECKPOINT_UNITS) {
            paintedSinceCheck = 0;
            yield;
          }
          if (cx === x1 && cy === y1) break;
          const e2 = 2 * err;
          if (e2 >= dy) {
            err += dy;
            cx += sx;
          }
          if (e2 <= dx) {
            err += dx;
            cy += sy;
          }
        }
      };
      yield* drawLine(point.x, point.y, to.x, to.y);
      const dx = to.x - point.x;
      const dy = to.y - point.y;
      const length = Math.hypot(dx, dy);
      if (length > 0) {
        const ux = dx / length;
        const uy = dy / length;
        const cos45 = Math.SQRT1_2;
        const sin45 = Math.SQRT1_2;
        // 箭翼从端点向主线反方向张开 ±45°、长度 6（端点 round 后 clamp）。
        const wingDirs = [
          [-ux * cos45 + uy * sin45, -ux * sin45 - uy * cos45],
          [-ux * cos45 - uy * sin45, ux * sin45 - uy * cos45],
        ];
        for (const [wx, wy] of wingDirs) {
          const endX = clampInt(Math.round(to.x + 6 * wx), 0, width - 1);
          const endY = clampInt(Math.round(to.y + 6 * wy), 0, height - 1);
          yield* drawLine(to.x, to.y, endX, endY);
        }
      }
    }

    for (const index of touched) {
      compositeSourceOver(rgba, index * 4, annotation.color);
      mask[index] = 0;
    }
    touched.length = 0;
    // 单个 annotation 的绘制受图幅/厚度约束；每个 annotation 结束检查一次取消与预算。
    yield;
  }
  return { width, height, rgba };
}

/** 标注：四类确定性 raster，返回新 Image（不修改输入）。 */
export function annotateImage(image, annotations, options = {}) {
  const ctx = createOpContext(options);
  return driveSync(annotateSteps(image, annotations, ctx), ctx, 'annotate');
}

/** annotateImage 的让出事件循环版本。 */
export async function annotateImageAsync(image, annotations, options = {}) {
  const ctx = createOpContext(options);
  return driveAsync(annotateSteps(image, annotations, ctx), ctx, 'annotate');
}

/* ------------------------------------------------------------------ */
/* 灰度 / Sobel 边缘                                                   */
/* ------------------------------------------------------------------ */

function whiteCompositedLuma(rgba, offset) {
  const alpha = rgba[offset + 3];
  const r = 255 + (rgba[offset] - 255) * (alpha / 255);
  const g = 255 + (rgba[offset + 1] - 255) * (alpha / 255);
  const b = 255 + (rgba[offset + 2] - 255) * (alpha / 255);
  return 0.29889531 * r + 0.58662247 * g + 0.11448223 * b;
}

function whiteCompositedGray(rgba, offset) {
  const alpha = rgba[offset + 3];
  const r = 255 + (rgba[offset] - 255) * (alpha / 255);
  const g = 255 + (rgba[offset + 1] - 255) * (alpha / 255);
  const b = 255 + (rgba[offset + 2] - 255) * (alpha / 255);
  return Math.round(0.299 * r + 0.587 * g + 0.114 * b);
}

function* edgeMaskSteps(image, threshold, ctx) {
  const width = image.width;
  const height = image.height;
  const rgba = image.rgba;
  const edges = new Uint8Array(width * height);
  if (width < 3 || height < 3) return edges;
  let rowA = new Uint8Array(width);
  let rowB = new Uint8Array(width);
  let rowC = new Uint8Array(width);
  const fillRow = (y, target) => {
    const base = y * width * 4;
    for (let x = 0; x < width; x += 1) target[x] = whiteCompositedGray(rgba, base + x * 4);
  };
  fillRow(0, rowA);
  fillRow(1, rowB);
  let nextCheckpoint = CHECKPOINT_UNITS;
  for (let y = 1; y < height - 1; y += 1) {
    fillRow(y + 1, rowC);
    const rowOut = y * width;
    for (let x = 1; x < width - 1; x += 1) {
      const gx = (rowC[x + 1] + 2 * rowC[x] + rowC[x - 1]) - (rowA[x + 1] + 2 * rowA[x] + rowA[x - 1]);
      const gy = (rowA[x - 1] + 2 * rowB[x - 1] + rowC[x - 1]) - (rowA[x + 1] + 2 * rowB[x + 1] + rowC[x + 1]);
      const magnitude = Math.min(255, Math.round((Math.abs(gx) + Math.abs(gy)) / 8));
      if (magnitude >= threshold && magnitude > 0) edges[rowOut + x] = 1;
    }
    const tmp = rowA;
    rowA = rowB;
    rowB = rowC;
    rowC = tmp;
    if ((y + 1) * width >= nextCheckpoint) {
      nextCheckpoint += CHECKPOINT_UNITS;
      yield;
    }
  }
  return edges;
}

/** Sobel 边缘 mask（白底合成灰度，边界一圈为 0），1=edge。 */
export function edgeMask(image, threshold = 32, options = {}) {
  assertImage(image, 'image');
  if (!Number.isInteger(threshold) || threshold < 0 || threshold > 255) {
    throw invalidArgument('threshold', 'invalid-threshold', 'edgeMask');
  }
  const ctx = createOpContext(options);
  return driveSync(edgeMaskSteps(image, threshold, ctx), ctx, 'edgeMask');
}

/** edgeMask 的让出事件循环版本。 */
export async function edgeMaskAsync(image, threshold = 32, options = {}) {
  assertImage(image, 'image');
  if (!Number.isInteger(threshold) || threshold < 0 || threshold > 255) {
    throw invalidArgument('threshold', 'invalid-threshold', 'edgeMask');
  }
  const ctx = createOpContext(options);
  return driveAsync(edgeMaskSteps(image, threshold, ctx), ctx, 'edgeMask');
}

/* ------------------------------------------------------------------ */
/* 全量统计                                                            */
/* ------------------------------------------------------------------ */

function* analyzeSteps(image, ctx) {
  assertImage(image, 'image');
  const width = image.width;
  const height = image.height;
  const pixels = width * height;
  const rgba = image.rgba;
  let transparentPixels = 0;
  let opaquePixels = 0;
  let sumR = 0;
  let sumG = 0;
  let sumB = 0;
  let sumA = 0;
  let minR = 255;
  let minG = 255;
  let minB = 255;
  let minA = 255;
  let maxR = 0;
  let maxG = 0;
  let maxB = 0;
  let maxA = 0;
  let uniform = true;
  const first = [rgba[0], rgba[1], rgba[2], rgba[3]];
  const buckets = new Map();
  let nextCheckpoint = CHECKPOINT_UNITS;
  for (let index = 0; index < pixels; index += 1) {
    const offset = index * 4;
    const r = rgba[offset];
    const g = rgba[offset + 1];
    const b = rgba[offset + 2];
    const a = rgba[offset + 3];
    if (a === 0) transparentPixels += 1;
    else if (a === 255) opaquePixels += 1;
    sumR += r;
    sumG += g;
    sumB += b;
    sumA += a;
    if (r < minR) minR = r;
    if (g < minG) minG = g;
    if (b < minB) minB = b;
    if (a < minA) minA = a;
    if (r > maxR) maxR = r;
    if (g > maxG) maxG = g;
    if (b > maxB) maxB = b;
    if (a > maxA) maxA = a;
    if (uniform && (r !== first[0] || g !== first[1] || b !== first[2] || a !== first[3])) {
      uniform = false;
    }
    const qr = Math.floor(r / 16) * 16;
    const qg = Math.floor(g / 16) * 16;
    const qb = Math.floor(b / 16) * 16;
    const qa = Math.floor(a / 16) * 16;
    const key = (((qr << 12) | (qg << 8) | (qb << 4) | (qa >> 4)) >>> 0);
    const bucket = buckets.get(key);
    if (bucket) bucket.count += 1;
    else buckets.set(key, { rgba: [qr, qg, qb, qa], count: 1 });
    if (index + 1 >= nextCheckpoint) {
      nextCheckpoint += CHECKPOINT_UNITS;
      yield;
    }
  }

  const dominantColors = [...buckets.values()]
    .sort((left, right) => {
      if (right.count !== left.count) return right.count - left.count;
      for (let channel = 0; channel < 4; channel += 1) {
        if (left.rgba[channel] !== right.rgba[channel]) return left.rgba[channel] - right.rgba[channel];
      }
      return 0;
    })
    .slice(0, 8)
    .map((bucket) => ({
      rgba: bucket.rgba,
      count: bucket.count,
      fraction: bucket.count / pixels,
    }));

  const edges = yield* edgeMaskSteps(image, 32, ctx);
  let edgePixels = 0;
  for (let index = 0; index < pixels; index += 1) {
    if (edges[index]) edgePixels += 1;
    if ((index + 1) % CHECKPOINT_UNITS === 0) yield;
  }

  return {
    pixelCount: pixels,
    transparentPixels,
    opaquePixels,
    averageRgba: [sumR / pixels, sumG / pixels, sumB / pixels, sumA / pixels],
    minRgba: [minR, minG, minB, minA],
    maxRgba: [maxR, maxG, maxB, maxA],
    uniform,
    dominantColors,
    edgePixels,
    edgeRatio: edgePixels / pixels,
  };
}

/** 全量统计（契约 §2.2 Analysis）。 */
export function analyzeImage(image, options = {}) {
  const ctx = createOpContext(options);
  return driveSync(analyzeSteps(image, ctx), ctx, 'analyze');
}

/** analyzeImage 的让出事件循环版本。 */
export async function analyzeImageAsync(image, options = {}) {
  const ctx = createOpContext(options);
  return driveAsync(analyzeSteps(image, ctx), ctx, 'analyze');
}

/* ------------------------------------------------------------------ */
/* YIQ 差异（yiq-v1）                                                  */
/* ------------------------------------------------------------------ */

const YIQ_DELTA_SCALE = 35215;

function yiqDeltaAt(beforeRgba, afterRgba, offset) {
  const aBefore = beforeRgba[offset + 3];
  const aAfter = afterRgba[offset + 3];
  const r1 = 255 + (beforeRgba[offset] - 255) * (aBefore / 255);
  const g1 = 255 + (beforeRgba[offset + 1] - 255) * (aBefore / 255);
  const b1 = 255 + (beforeRgba[offset + 2] - 255) * (aBefore / 255);
  const r2 = 255 + (afterRgba[offset] - 255) * (aAfter / 255);
  const g2 = 255 + (afterRgba[offset + 1] - 255) * (aAfter / 255);
  const b2 = 255 + (afterRgba[offset + 2] - 255) * (aAfter / 255);
  const dR = r1 - r2;
  const dG = g1 - g2;
  const dB = b1 - b2;
  const y = 0.29889531 * dR + 0.58662247 * dG + 0.11448223 * dB;
  const i = 0.59597799 * dR - 0.27417610 * dG - 0.32180189 * dB;
  const q = 0.21147017 * dR - 0.52261711 * dG + 0.31114694 * dB;
  return 0.5053 * y * y + 0.299 * i * i + 0.1957 * q * q;
}

function countEqualRgbaNeighbors(rgba, width, height, x, y) {
  const offset = (y * width + x) * 4;
  const r = rgba[offset];
  const g = rgba[offset + 1];
  const b = rgba[offset + 2];
  const a = rgba[offset + 3];
  let count = 0;
  const yStart = Math.max(0, y - 1);
  const yEnd = Math.min(height - 1, y + 1);
  const xStart = Math.max(0, x - 1);
  const xEnd = Math.min(width - 1, x + 1);
  for (let ny = yStart; ny <= yEnd; ny += 1) {
    for (let nx = xStart; nx <= xEnd; nx += 1) {
      if (nx === x && ny === y) continue;
      const other = (ny * width + nx) * 4;
      if (rgba[other] === r && rgba[other + 1] === g && rgba[other + 2] === b && rgba[other + 3] === a) {
        count += 1;
      }
    }
  }
  return count;
}

function aaForImage(rgba, otherRgba, width, height, x, y) {
  const centerLuma = whiteCompositedLuma(rgba, (y * width + x) * 4);
  const onBorder = x === 0 || y === 0 || x === width - 1 || y === height - 1;
  let equal = onBorder ? 1 : 0;
  let minLuma = Infinity;
  let maxLuma = -Infinity;
  let minPos = null;
  let maxPos = null;
  const yStart = Math.max(0, y - 1);
  const yEnd = Math.min(height - 1, y + 1);
  const xStart = Math.max(0, x - 1);
  const xEnd = Math.min(width - 1, x + 1);
  for (let ny = yStart; ny <= yEnd; ny += 1) {
    for (let nx = xStart; nx <= xEnd; nx += 1) {
      if (nx === x && ny === y) continue;
      const luma = whiteCompositedLuma(rgba, (ny * width + nx) * 4);
      if (luma === centerLuma) {
        equal += 1;
        if (equal > 2) return false;
      } else if (luma < centerLuma) {
        if (luma < minLuma) {
          minLuma = luma;
          minPos = { x: nx, y: ny };
        }
      } else if (luma > maxLuma) {
        maxLuma = luma;
        maxPos = { x: nx, y: ny };
      }
    }
  }
  if (!minPos || !maxPos) return false;
  for (const position of [minPos, maxPos]) {
    if (countEqualRgbaNeighbors(rgba, width, height, position.x, position.y) >= 3
      && countEqualRgbaNeighbors(otherRgba, width, height, position.x, position.y) >= 3) {
      return true;
    }
  }
  return false;
}

function isAntialiasedPair(before, after, width, height, x, y) {
  return aaForImage(before.rgba, after.rgba, width, height, x, y)
    || aaForImage(after.rgba, before.rgba, width, height, x, y);
}

/** 区域排序：area 降序、y 升序、x 升序、height 升序、width 升序（<0 表示 left 更靠前）。 */
function compareRegions(left, right) {
  if (right.area !== left.area) return right.area - left.area;
  if (left.y !== right.y) return left.y - right.y;
  if (left.x !== right.x) return left.x - right.x;
  if (left.height !== right.height) return left.height - right.height;
  return left.width - right.width;
}

/** 只保留排序最前的 100 个区域（流式插入），避免病态差异图撑爆内存。 */
function insertTopRegion(top, candidate) {
  const LIMIT = 100;
  if (top.length >= LIMIT && compareRegions(candidate, top[top.length - 1]) >= 0) return;
  let low = 0;
  let high = top.length >= LIMIT ? top.length - 1 : top.length;
  while (low < high) {
    const mid = (low + high) >> 1;
    if (compareRegions(candidate, top[mid]) < 0) high = mid;
    else low = mid + 1;
  }
  top.splice(low, 0, candidate);
  if (top.length > LIMIT) top.pop();
}

function* diffRegionSteps(diffMap, region, minRegionPixels, ctx) {
  const width = region.width;
  const height = region.height;
  const total = width * height;
  const visited = new Uint8Array(total);
  let stack = new Int32Array(4096);
  const found = [];
  let regionCount = 0;
  let sinceCheckpoint = 0;
  for (let index = 0; index < total; index += 1) {
    if (diffMap[index] !== 1 || visited[index]) {
      sinceCheckpoint += 1;
      if (sinceCheckpoint >= CHECKPOINT_UNITS) {
        sinceCheckpoint = 0;
        yield;
      }
      continue;
    }
    let top = 0;
    stack[top] = index;
    top += 1;
    visited[index] = 1;
    let area = 0;
    let minX = width;
    let minY = height;
    let maxX = -1;
    let maxY = -1;
    while (top > 0) {
      top -= 1;
      const current = stack[top];
      const localX = current % width;
      const localY = (current - localX) / width;
      area += 1;
      if (localX < minX) minX = localX;
      if (localX > maxX) maxX = localX;
      if (localY < minY) minY = localY;
      if (localY > maxY) maxY = localY;
      for (let dy = -1; dy <= 1; dy += 1) {
        const ny = localY + dy;
        if (ny < 0 || ny >= height) continue;
        for (let dx = -1; dx <= 1; dx += 1) {
          if (dx === 0 && dy === 0) continue;
          const nx = localX + dx;
          if (nx < 0 || nx >= width) continue;
          const neighbor = ny * width + nx;
          if (diffMap[neighbor] === 1 && !visited[neighbor]) {
            visited[neighbor] = 1;
            if (top >= stack.length) {
              const grown = new Int32Array(stack.length * 2);
              grown.set(stack);
              stack = grown;
            }
            stack[top] = neighbor;
            top += 1;
          }
        }
      }
      sinceCheckpoint += 1;
      if (sinceCheckpoint >= CHECKPOINT_UNITS) {
        sinceCheckpoint = 0;
        yield;
      }
    }
    if (area >= minRegionPixels) {
      regionCount += 1;
      insertTopRegion(found, {
        area,
        x: region.x + minX,
        y: region.y + minY,
        width: maxX - minX + 1,
        height: maxY - minY + 1,
      });
    }
    sinceCheckpoint += 1;
    if (sinceCheckpoint >= CHECKPOINT_UNITS) {
      sinceCheckpoint = 0;
      yield;
    }
  }
  return { regions: found, count: regionCount };
}

function* diffSteps(beforeImage, afterImage, params, ctx) {
  assertImage(beforeImage, 'before');
  assertImage(afterImage, 'after');
  const width = beforeImage.width;
  const height = beforeImage.height;
  if (afterImage.width !== width || afterImage.height !== height) {
    throw new BrowserError('VISION_SIZE_MISMATCH', 'compare 两图像素尺寸不一致', {
      before: { width, height },
      after: { width: afterImage.width, height: afterImage.height },
    });
  }
  const region = params.region === undefined || params.region === null
    ? { x: 0, y: 0, width, height }
    : validatePixelRect(params.region, 'region');
  if (region.x + region.width > width || region.y + region.height > height) {
    throw invalidArgument('region', 'out-of-bounds', 'diffImages');
  }
  const masks = params.masks === undefined || params.masks === null ? [] : validateMasks(params.masks, 'masks');
  for (let index = 0; index < masks.length; index += 1) {
    const maskRegion = masks[index].region;
    if (maskRegion.x + maskRegion.width > width || maskRegion.y + maskRegion.height > height) {
      throw invalidArgument(`masks[${index}].region`, 'out-of-bounds', 'diffImages');
    }
  }
  const options = validateDiffOptions(params.options === null ? undefined : params.options, 'options');

  const roiPixels = region.width * region.height;
  const estimate = 16 * width * height + 7 * roiPixels
    + Math.min(4 * width * height, VISION_LIMITS.maxOutputBytes);
  if (estimate > VISION_LIMITS.maxWorkingSetBytes) {
    throw visionLimitExceeded(
      'maxWorkingSetBytes',
      estimate,
      VISION_LIMITS.maxWorkingSetBytes,
      'compare 工作集超限',
    );
  }

  const maskMap = new Uint8Array(roiPixels);
  let maskedPixels = 0;
  let maskWork = 0;
  for (const mask of masks) {
    const startX = Math.max(mask.region.x, region.x);
    const startY = Math.max(mask.region.y, region.y);
    const endX = Math.min(mask.region.x + mask.region.width, region.x + region.width);
    const endY = Math.min(mask.region.y + mask.region.height, region.y + region.height);
    for (let gy = startY; gy < endY; gy += 1) {
      for (let gx = startX; gx < endX; gx += 1) {
        const roiIndex = (gy - region.y) * region.width + (gx - region.x);
        if (!maskMap[roiIndex]) {
          maskMap[roiIndex] = 1;
          maskedPixels += 1;
        }
      }
      maskWork += endX - startX;
      if (maskWork >= CHECKPOINT_UNITS) {
        maskWork = 0;
        yield;
      }
    }
  }

  const beforeRgba = beforeImage.rgba;
  const afterRgba = afterImage.rgba;
  const highlight = new Uint8Array(width * height * 4);
  const diffMap = new Uint8Array(roiPixels);
  const aaMap = new Uint8Array(roiPixels);
  const thresholdSquared = YIQ_DELTA_SCALE * options.threshold * options.threshold;
  let diffPixels = 0;
  let aaPixels = 0;
  let nextCheckpoint = CHECKPOINT_UNITS;

  for (let y = 0; y < height; y += 1) {
    const rowBase = y * width * 4;
    for (let x = 0; x < width; x += 1) {
      const offset = rowBase + x * 4;
      const out = offset;
      const lumaBefore = whiteCompositedLuma(beforeRgba, offset);
      const gray = clampByte(Math.round(255 * 0.9 + lumaBefore * 0.1));
      highlight[out] = gray;
      highlight[out + 1] = gray;
      highlight[out + 2] = gray;
      highlight[out + 3] = 255;
      if (x < region.x || x >= region.x + region.width || y < region.y || y >= region.y + region.height) {
        continue;
      }
      const roiIndex = (y - region.y) * region.width + (x - region.x);
      if (maskMap[roiIndex]) {
        highlight[out] = 128;
        highlight[out + 1] = 128;
        highlight[out + 2] = 128;
        continue;
      }
      if (beforeRgba[offset] === afterRgba[offset]
        && beforeRgba[offset + 1] === afterRgba[offset + 1]
        && beforeRgba[offset + 2] === afterRgba[offset + 2]
        && beforeRgba[offset + 3] === afterRgba[offset + 3]) {
        continue;
      }
      const delta = yiqDeltaAt(beforeRgba, afterRgba, offset);
      if (!(delta > thresholdSquared)) continue;
      if (!options.includeAA && isAntialiasedPair(beforeImage, afterImage, width, height, x, y)) {
        aaPixels += 1;
        aaMap[roiIndex] = 1;
        highlight[out] = 255;
        highlight[out + 1] = 255;
        highlight[out + 2] = 0;
        continue;
      }
      diffPixels += 1;
      diffMap[roiIndex] = 1;
      highlight[out] = 255;
      highlight[out + 1] = 0;
      highlight[out + 2] = 0;
    }
    if ((y + 1) * width >= nextCheckpoint) {
      nextCheckpoint += CHECKPOINT_UNITS;
      yield;
    }
  }

  const totalPixels = roiPixels;
  const comparedPixels = totalPixels - maskedPixels;
  if (comparedPixels <= 0) {
    throw new BrowserError('VISION_EMPTY_COMPARISON', 'ROI 内所有像素都被 mask 排除，无法比较');
  }

  const found = yield* diffRegionSteps(diffMap, region, options.minRegionPixels, ctx);
  const regionCount = found.count;
  const regionsTruncated = regionCount > 100;
  const selected = found.regions;

  // 高亮 bbox 内边框（1px，按排序绘制；统计已在绘制前完成）。
  for (const item of selected) {
    const right = item.x + item.width - 1;
    const bottom = item.y + item.height - 1;
    for (let x = item.x; x <= right; x += 1) {
      const topOffset = (item.y * width + x) * 4;
      highlight[topOffset] = 0;
      highlight[topOffset + 1] = 128;
      highlight[topOffset + 2] = 255;
      highlight[topOffset + 3] = 255;
      const bottomOffset = (bottom * width + x) * 4;
      highlight[bottomOffset] = 0;
      highlight[bottomOffset + 1] = 128;
      highlight[bottomOffset + 2] = 255;
      highlight[bottomOffset + 3] = 255;
    }
    for (let y = item.y; y <= bottom; y += 1) {
      const leftOffset = (y * width + item.x) * 4;
      highlight[leftOffset] = 0;
      highlight[leftOffset + 1] = 128;
      highlight[leftOffset + 2] = 255;
      highlight[leftOffset + 3] = 255;
      const rightOffset = (y * width + right) * 4;
      highlight[rightOffset] = 0;
      highlight[rightOffset + 1] = 128;
      highlight[rightOffset + 2] = 255;
      highlight[rightOffset + 3] = 255;
    }
  }

  const highlightPng = yield* encodePngSteps({ width, height, rgba: highlight }, ctx);
  const regions = selected.map((item, index) => ({
    id: `r${index + 1}`,
    area: item.area,
    imagePixels: { x: item.x, y: item.y, width: item.width, height: item.height },
  }));

  return {
    metrics: {
      totalPixels,
      maskedPixels,
      comparedPixels,
      diffPixels,
      aaPixels,
      diffRatio: diffPixels / comparedPixels,
      similarity: 1 - diffPixels / comparedPixels,
    },
    regions,
    regionCount,
    regionsTruncated,
    highlight: highlightPng,
  };
}

/**
 * YIQ 差异（yiq-v1）：白底合成、严格 >、AA 3×3 排除、mask 并集、分母 C=N-M、
 * 8 邻接连通域、完整尺寸 annotated diff PNG。
 */
export function diffImages(beforeImage, afterImage, params = {}) {
  const ctx = createOpContext(params);
  return driveSync(diffSteps(beforeImage, afterImage, params, ctx), ctx, 'diff');
}

/** diffImages 的让出事件循环版本。 */
export async function diffImagesAsync(beforeImage, afterImage, params = {}) {
  const ctx = createOpContext(params);
  return driveAsync(diffSteps(beforeImage, afterImage, params, ctx), ctx, 'diff');
}

/* ------------------------------------------------------------------ */
/* 识别（color/components/edges/template）                             */
/* ------------------------------------------------------------------ */

function* componentSteps(foreground, width, height, minArea, ctx) {
  const total = width * height;
  let stack = new Int32Array(4096);
  const found = [];
  let sinceCheckpoint = 0;
  for (let index = 0; index < total; index += 1) {
    if (foreground[index] !== 1) {
      sinceCheckpoint += 1;
      if (sinceCheckpoint >= CHECKPOINT_UNITS) {
        sinceCheckpoint = 0;
        yield;
      }
      continue;
    }
    let top = 0;
    stack[top] = index;
    top += 1;
    foreground[index] = 2;
    let area = 0;
    let minX = width;
    let minY = height;
    let maxX = -1;
    let maxY = -1;
    let sumX = 0;
    let sumY = 0;
    while (top > 0) {
      top -= 1;
      const current = stack[top];
      const localX = current % width;
      const localY = (current - localX) / width;
      area += 1;
      sumX += localX;
      sumY += localY;
      if (localX < minX) minX = localX;
      if (localX > maxX) maxX = localX;
      if (localY < minY) minY = localY;
      if (localY > maxY) maxY = localY;
      for (let dy = -1; dy <= 1; dy += 1) {
        const ny = localY + dy;
        if (ny < 0 || ny >= height) continue;
        for (let dx = -1; dx <= 1; dx += 1) {
          if (dx === 0 && dy === 0) continue;
          const nx = localX + dx;
          if (nx < 0 || nx >= width) continue;
          const neighbor = ny * width + nx;
          if (foreground[neighbor] === 1) {
            foreground[neighbor] = 2;
            if (top >= stack.length) {
              const grown = new Int32Array(stack.length * 2);
              grown.set(stack);
              stack = grown;
            }
            stack[top] = neighbor;
            top += 1;
          }
        }
      }
      sinceCheckpoint += 1;
      if (sinceCheckpoint >= CHECKPOINT_UNITS) {
        sinceCheckpoint = 0;
        yield;
      }
    }
    if (area >= minArea) {
      found.push({ area, minX, minY, maxX, maxY, sumX, sumY });
    }
    sinceCheckpoint += 1;
    if (sinceCheckpoint >= CHECKPOINT_UNITS) {
      sinceCheckpoint = 0;
      yield;
    }
  }
  return found;
}

function buildCandidates(components, roi, maxResults, signal) {
  const mapped = components.map((component) => {
    const x = roi.x + component.minX;
    const y = roi.y + component.minY;
    const width = component.maxX - component.minX + 1;
    const height = component.maxY - component.minY + 1;
    const centroidX = roi.x + component.sumX / component.area + 0.5;
    const centroidY = roi.y + component.sumY / component.area + 0.5;
    return {
      region: { x, y, width, height },
      centroid: { x: centroidX, y: centroidY },
      area: component.area,
      score: component.area / (width * height),
      signal,
    };
  });
  mapped.sort((left, right) => {
    if (right.area !== left.area) return right.area - left.area;
    if (left.region.y !== right.region.y) return left.region.y - right.region.y;
    if (left.region.x !== right.region.x) return left.region.x - right.region.x;
    if (left.region.height !== right.region.height) return left.region.height - right.region.height;
    return left.region.width - right.region.width;
  });
  const totalCandidates = mapped.length;
  const truncated = totalCandidates > maxResults;
  const candidates = mapped.slice(0, maxResults).map((item, index) => ({
    id: `c${index + 1}`,
    region: item.region,
    documentCss: null,
    centroid: item.centroid,
    area: item.area,
    score: item.score,
    signal: item.signal,
    semanticName: null,
  }));
  return { candidates, totalCandidates, truncated };
}

function iouOfBoxes(left, right, width, height) {
  const leftX = Math.max(left.x, right.x);
  const leftY = Math.max(left.y, right.y);
  const rightX = Math.min(left.x + width, right.x + width);
  const rightY = Math.min(left.y + height, right.y + height);
  if (rightX <= leftX || rightY <= leftY) return 0;
  const intersection = (rightX - leftX) * (rightY - leftY);
  const union = 2 * width * height - intersection;
  return intersection / union;
}

function* templateSearchSteps(image, templateImage, roi, query, ctx) {
  const templateWidth = templateImage.width;
  const templateHeight = templateImage.height;
  const stride = query.stride;
  const positionsX = Math.floor((roi.width - templateWidth) / stride) + 1;
  const positionsY = Math.floor((roi.height - templateHeight) / stride) + 1;
  const positions = positionsX * positionsY;
  const templatePixels = templateWidth * templateHeight;
  const comparisons = positions * templatePixels;
  if (comparisons > VISION_LIMITS.maxTemplateComparisons) {
    throw visionLimitExceeded(
      'maxTemplateComparisons',
      comparisons,
      VISION_LIMITS.maxTemplateComparisons,
      '模板候选像素比较次数超限',
    );
  }

  const templateR = new Float64Array(templatePixels);
  const templateG = new Float64Array(templatePixels);
  const templateB = new Float64Array(templatePixels);
  for (let index = 0; index < templatePixels; index += 1) {
    const offset = index * 4;
    const alpha = templateImage.rgba[offset + 3];
    templateR[index] = 255 + (templateImage.rgba[offset] - 255) * (alpha / 255);
    templateG[index] = 255 + (templateImage.rgba[offset + 1] - 255) * (alpha / 255);
    templateB[index] = 255 + (templateImage.rgba[offset + 2] - 255) * (alpha / 255);
  }
  const denominator = 255 * 3 * templatePixels;
  const rgba = image.rgba;
  const imageWidth = image.width;
  const matches = [];
  const maxMatchEntries = 1000000;
  let comparisonsSinceCheck = 0;
  for (let py = 0; py < positionsY; py += 1) {
    const originY = roi.y + py * stride;
    for (let px = 0; px < positionsX; px += 1) {
      const originX = roi.x + px * stride;
      let sum = 0;
      for (let ty = 0; ty < templateHeight; ty += 1) {
        const rowBase = ((originY + ty) * imageWidth + originX) * 4;
        const templateRow = ty * templateWidth;
        for (let tx = 0; tx < templateWidth; tx += 1) {
          const offset = rowBase + tx * 4;
          const alpha = rgba[offset + 3];
          const r = 255 + (rgba[offset] - 255) * (alpha / 255);
          const g = 255 + (rgba[offset + 1] - 255) * (alpha / 255);
          const b = 255 + (rgba[offset + 2] - 255) * (alpha / 255);
          const templateIndex = templateRow + tx;
          sum += Math.abs(r - templateR[templateIndex])
            + Math.abs(g - templateG[templateIndex])
            + Math.abs(b - templateB[templateIndex]);
        }
        comparisonsSinceCheck += templateWidth;
        if (comparisonsSinceCheck >= CHECKPOINT_UNITS) {
          comparisonsSinceCheck = 0;
          yield;
        }
      }
      const score = 1 - sum / denominator;
      if (score >= query.minScore) {
        matches.push({ x: originX, y: originY, score });
        if (matches.length > maxMatchEntries) {
          throw visionLimitExceeded(
            'maxTemplateMatches',
            matches.length,
            maxMatchEntries,
            '模板命中的候选位置超出工作集预算，请提高 minScore 或缩小 ROI',
          );
        }
      }
    }
  }

  matches.sort((left, right) => {
    if (right.score !== left.score) return right.score - left.score;
    if (left.y !== right.y) return left.y - right.y;
    return left.x - right.x;
  });
  const kept = [];
  for (const match of matches) {
    let suppressed = false;
    for (const survivor of kept) {
      if (iouOfBoxes(match, survivor, templateWidth, templateHeight) > 0.3) {
        suppressed = true;
        break;
      }
    }
    if (!suppressed) kept.push(match);
  }
  const totalCandidates = kept.length;
  const truncated = totalCandidates > query.maxResults;
  const candidates = kept.slice(0, query.maxResults).map((match, index) => ({
    id: `c${index + 1}`,
    region: { x: match.x, y: match.y, width: templateWidth, height: templateHeight },
    documentCss: null,
    centroid: { x: match.x + templateWidth / 2, y: match.y + templateHeight / 2 },
    area: templatePixels,
    score: match.score,
    signal: 'template',
    semanticName: null,
  }));
  return {
    candidates,
    totalCandidates,
    truncated,
    metrics: {
      foregroundPixels: null,
      evaluatedPositions: positions,
      pixelComparisons: comparisons,
      algorithm: 'template-v1',
    },
  };
}

function* findSteps(image, query, params, ctx) {
  assertImage(image, 'image');
  const parsed = validateQuery(query, 'query');
  const width = image.width;
  const height = image.height;
  const roi = params.roi === undefined || params.roi === null
    ? { x: 0, y: 0, width, height }
    : validatePixelRect(params.roi, 'roi');
  if (roi.x + roi.width > width || roi.y + roi.height > height) {
    throw invalidArgument('roi', 'out-of-bounds', 'findInImage');
  }
  if (parsed.method === 'template') {
    const templateImage = params.templateImage;
    assertImage(templateImage, 'template');
    if (templateImage.width > roi.width || templateImage.height > roi.height) {
      throw invalidArgument('template', 'template-larger-than-roi', 'findInImage');
    }
    return yield* templateSearchSteps(image, templateImage, roi, parsed, ctx);
  }

  const roiPixels = roi.width * roi.height;
  const foreground = new Uint8Array(roiPixels);
  let foregroundPixels = 0;
  if (parsed.method === 'edges') {
    const edges = yield* edgeMaskSteps(image, parsed.edgeThreshold, ctx);
    let nextCheckpoint = CHECKPOINT_UNITS;
    for (let y = 0; y < roi.height; y += 1) {
      const edgeRow = (roi.y + y) * width;
      const outRow = y * roi.width;
      for (let x = 0; x < roi.width; x += 1) {
        if (edges[edgeRow + roi.x + x]) {
          foreground[outRow + x] = 1;
          foregroundPixels += 1;
        }
      }
      if ((y + 1) * roi.width >= nextCheckpoint) {
        nextCheckpoint += CHECKPOINT_UNITS;
        yield;
      }
    }
  } else {
    const rgba = image.rgba;
    const isColor = parsed.method === 'color';
    const target = isColor ? parsed.color : parsed.background;
    const tolerance = parsed.tolerance;
    let nextCheckpoint = CHECKPOINT_UNITS;
    for (let y = 0; y < roi.height; y += 1) {
      const sourceRow = (roi.y + y) * width;
      const outRow = y * roi.width;
      for (let x = 0; x < roi.width; x += 1) {
        const offset = (sourceRow + roi.x + x) * 4;
        const alpha = rgba[offset + 3];
        if (alpha === 0) continue;
        const dR = Math.abs(rgba[offset] - target[0]);
        const dG = Math.abs(rgba[offset + 1] - target[1]);
        const dB = Math.abs(rgba[offset + 2] - target[2]);
        const maxDelta = Math.max(dR, dG, dB);
        const isForeground = isColor ? maxDelta <= tolerance : maxDelta > tolerance;
        if (isForeground) {
          foreground[outRow + x] = 1;
          foregroundPixels += 1;
        }
      }
      if ((y + 1) * roi.width >= nextCheckpoint) {
        nextCheckpoint += CHECKPOINT_UNITS;
        yield;
      }
    }
  }

  const components = yield* componentSteps(foreground, roi.width, roi.height, parsed.minArea, ctx);
  const signal = parsed.method === 'color' ? 'color' : parsed.method === 'components' ? 'component' : 'edge';
  const built = buildCandidates(components, roi, parsed.maxResults, signal);
  return {
    candidates: built.candidates,
    totalCandidates: built.totalCandidates,
    truncated: built.truncated,
    metrics: {
      foregroundPixels,
      evaluatedPositions: null,
      pixelComparisons: roiPixels,
      algorithm: `${parsed.method}-v1`,
    },
  };
}

/**
 * 确定性识别：color/components/edges/template。
 * 返回 `{candidates,totalCandidates,truncated,metrics}`；候选坐标为完整输入图坐标。
 */
export function findInImage(image, query, params = {}) {
  const ctx = createOpContext(params);
  return driveSync(findSteps(image, query, params, ctx), ctx, 'find');
}

/** findInImage 的让出事件循环版本。 */
export async function findInImageAsync(image, query, params = {}) {
  const ctx = createOpContext(params);
  return driveAsync(findSteps(image, query, params, ctx), ctx, 'find');
}

/* ------------------------------------------------------------------ */
/* 几何映射（image px → document CSS；viewport 由 Host 减现场 scroll）  */
/* ------------------------------------------------------------------ */

function isMapping(value) {
  return isPlainObject(value)
    && isPlainObject(value.originCss)
    && isPlainObject(value.cssPerPixel)
    && Number.isFinite(value.originCss.x)
    && Number.isFinite(value.originCss.y)
    && Number.isFinite(value.cssPerPixel.x)
    && Number.isFinite(value.cssPerPixel.y)
    && value.cssPerPixel.x > 0
    && value.cssPerPixel.y > 0;
}

/** 图像点 → document CSS 点；无 mapping 返回 null。 */
export function mapImagePointToDocument(mapping, point) {
  if (!isMapping(mapping) || !isPlainObject(point)) return null;
  const { x, y } = point;
  if (!Number.isFinite(x) || !Number.isFinite(y)) return null;
  return {
    x: mapping.originCss.x + x * mapping.cssPerPixel.x,
    y: mapping.originCss.y + y * mapping.cssPerPixel.y,
  };
}

/** 图像矩形 → document CSS 矩形（区域用边缘而非像素中心）；无 mapping 返回 null。 */
export function mapImageRectToDocument(mapping, rect) {
  if (!isMapping(mapping) || !isPlainObject(rect)) return null;
  const { x, y, width, height } = rect;
  if (![x, y, width, height].every((value) => Number.isFinite(value))) return null;
  const left = mapping.originCss.x + x * mapping.cssPerPixel.x;
  const top = mapping.originCss.y + y * mapping.cssPerPixel.y;
  const right = mapping.originCss.x + (x + width) * mapping.cssPerPixel.x;
  const bottom = mapping.originCss.y + (y + height) * mapping.cssPerPixel.y;
  return { x: left, y: top, width: right - left, height: bottom - top };
}

/** 两个 mapping 是否兼容（coordinateSpace + originCss/cssPerPixel/capturedCssRect 逐轴差 ≤1e-9）。 */
export function mappingCompatible(left, right) {
  if (!isMapping(left) || !isMapping(right)) return false;
  if (left.coordinateSpace !== right.coordinateSpace) return false;
  const epsilon = 1e-9;
  const near = (a, b) => Number.isFinite(a) && Number.isFinite(b) && Math.abs(a - b) <= epsilon;
  if (!near(left.originCss.x, right.originCss.x) || !near(left.originCss.y, right.originCss.y)) return false;
  if (!near(left.cssPerPixel.x, right.cssPerPixel.x) || !near(left.cssPerPixel.y, right.cssPerPixel.y)) return false;
  const leftRect = left.capturedCssRect;
  const rightRect = right.capturedCssRect;
  if (!isPlainObject(leftRect) || !isPlainObject(rightRect)) return false;
  return near(leftRect.x, rightRect.x)
    && near(leftRect.y, rightRect.y)
    && near(leftRect.width, rightRect.width)
    && near(leftRect.height, rightRect.height);
}

/** 裁剪后的派生 mapping：原点加 crop 偏移，cssPerPixel 不变。 */
export function mappingAfterCrop(mapping, rect) {
  if (!isMapping(mapping) || !isPlainObject(rect)) return null;
  const { x, y, width, height } = rect;
  if (![x, y, width, height].every((value) => Number.isFinite(value))) return null;
  const originCss = {
    x: mapping.originCss.x + x * mapping.cssPerPixel.x,
    y: mapping.originCss.y + y * mapping.cssPerPixel.y,
  };
  const capturedCssRect = isPlainObject(mapping.capturedCssRect)
    ? {
      x: originCss.x,
      y: originCss.y,
      width: width * mapping.cssPerPixel.x,
      height: height * mapping.cssPerPixel.y,
    }
    : null;
  return {
    ...mapping,
    originCss,
    imagePixels: { width, height },
    capturedCssRect,
  };
}

/** 缩放后的派生 mapping：cssPerPixel 按实际 sx=Wout/Win、sy=Hout/Hin 缩小。 */
export function mappingAfterResize(mapping, width, height) {
  if (!isMapping(mapping) || !Number.isFinite(width) || !Number.isFinite(height)) return null;
  if (width <= 0 || height <= 0) return null;
  const sourceWidth = isPlainObject(mapping.imagePixels) ? mapping.imagePixels.width : null;
  const sourceHeight = isPlainObject(mapping.imagePixels) ? mapping.imagePixels.height : null;
  if (!Number.isFinite(sourceWidth) || !Number.isFinite(sourceHeight) || sourceWidth <= 0 || sourceHeight <= 0) {
    return null;
  }
  const sx = width / sourceWidth;
  const sy = height / sourceHeight;
  return {
    ...mapping,
    cssPerPixel: { x: mapping.cssPerPixel.x / sx, y: mapping.cssPerPixel.y / sy },
    imagePixels: { width, height },
  };
}

/* ------------------------------------------------------------------ */
/* 阈值判定 helper（compare/check 共用；相等按较低等级）               */
/* ------------------------------------------------------------------ */

/** diffRatio → 'PASS'|'WARN'|'FAIL'（严格 >，相等按较低等级）。 */
export function ratioVerdict(diffRatio, thresholds = DEFAULT_THRESHOLDS) {
  if (!Number.isFinite(diffRatio)) throw invalidArgument('diffRatio', 'not-a-finite-number', 'ratioVerdict');
  const parsed = validateThresholds(thresholds, 'thresholds');
  if (diffRatio > parsed.failRatio) return 'FAIL';
  if (diffRatio > parsed.warnRatio) return 'WARN';
  return 'PASS';
}

/* ------------------------------------------------------------------ */
/* Product store                                                       */
/* ------------------------------------------------------------------ */

function productKind(kind) {
  if (kind === 'capture' || kind === 'derived' || kind === 'diff' || kind === 'baseline') return kind;
  throw invalidArgument('kind', 'invalid-enum', 'product');
}

/**
 * 每 scope 的 product store（契约 §1.1）：16 项 / 128MiB 编码字节 / 单张 32MiB / 单图 16M px；
 * `v1_<32hex>` ID、LRU 读刷新、pin 不可淘汰、clear/stats。只保存编码字节与 lineage，
 * 不长期持有解码缓冲。
 */
export class VisionProductStore {
  constructor({ now } = {}) {
    this._now = typeof now === 'function' ? now : () => Date.now();
    this._entries = new Map();
    this._totalBytes = 0;
    this._tick = 0;
  }

  _touch(record) {
    this._tick += 1;
    record.lastAccess = this._tick;
  }

  _view(record) {
    return {
      productId: record.productId,
      width: record.width,
      height: record.height,
      bytes: record.bytes,
      sha256: record.sha256,
      rgbaSha256: record.rgbaSha256,
      kind: record.kind,
      mapping: record.mapping,
      actionable: record.actionable,
      parentIds: record.parentIds,
      operations: record.operations,
      createdAt: record.createdAt,
      capturedAt: record.capturedAt,
      pinned: record.pins > 0,
    };
  }

  _evictOne() {
    let victim = null;
    for (const record of this._entries.values()) {
      if (record.pins > 0) continue;
      if (!victim || record.lastAccess < victim.lastAccess) victim = record;
    }
    if (!victim) return false;
    this._entries.delete(victim.productId);
    this._totalBytes -= victim.bytes.length;
    return true;
  }

  _newProductId() {
    for (;;) {
      const productId = `v1_${randomBytes(16).toString('hex')}`;
      if (!this._entries.has(productId)) return productId;
    }
  }

  add(entry) {
    const input = assertObject(entry, 'product');
    const bytes = toBuffer(input.bytes);
    if (!bytes || bytes.length === 0) throw invalidArgument('bytes', 'invalid-bytes', 'product');
    if (bytes.length > VISION_LIMITS.maxProductBytes) {
      throw visionLimitExceeded('maxProductBytes', bytes.length, VISION_LIMITS.maxProductBytes, '单张 product 编码字节超限');
    }
    const width = input.width;
    const height = input.height;
    if (!Number.isInteger(width) || width <= 0) throw invalidArgument('width', 'invalid-dimensions', 'product');
    if (!Number.isInteger(height) || height <= 0) throw invalidArgument('height', 'invalid-dimensions', 'product');
    const pixels = width * height;
    if (pixels > VISION_LIMITS.maxProductPixels) {
      throw visionLimitExceeded('maxProductPixels', pixels, VISION_LIMITS.maxProductPixels, '单张 product 像素超限');
    }
    const kind = productKind(input.kind);
    const actionable = input.actionable === undefined ? false : input.actionable;
    if (typeof actionable !== 'boolean') throw invalidArgument('actionable', 'not-a-boolean', 'product');
    const createdAt = input.createdAt === undefined ? this._now() : input.createdAt;
    if (!Number.isFinite(createdAt) || createdAt < 0) throw invalidArgument('createdAt', 'invalid-epoch-ms', 'product');
    const capturedAt = input.capturedAt === undefined ? null : input.capturedAt;
    if (capturedAt !== null && (!Number.isFinite(capturedAt) || capturedAt < 0)) {
      throw invalidArgument('capturedAt', 'invalid-epoch-ms', 'product');
    }
    let sha256 = input.sha256;
    if (sha256 === undefined || sha256 === null) {
      sha256 = sha256Hex(bytes);
    } else if (typeof sha256 !== 'string' || !/^[0-9a-f]{64}$/.test(sha256)) {
      throw invalidArgument('sha256', 'invalid-sha256', 'product');
    }
    let rgbaSha256 = input.rgbaSha256 === undefined ? null : input.rgbaSha256;
    if (rgbaSha256 !== null && (typeof rgbaSha256 !== 'string' || !/^[0-9a-f]{64}$/.test(rgbaSha256))) {
      throw invalidArgument('rgbaSha256', 'invalid-sha256', 'product');
    }
    const mapping = input.mapping === undefined ? null : input.mapping;
    if (mapping !== null && !isPlainObject(mapping)) throw invalidArgument('mapping', 'invalid-mapping', 'product');
    const parentIds = input.parentIds === undefined ? [] : input.parentIds;
    if (!Array.isArray(parentIds) || parentIds.some((id) => typeof id !== 'string')) {
      throw invalidArgument('parentIds', 'invalid-string-list', 'product');
    }
    const operations = input.operations === undefined ? [] : input.operations;
    if (!Array.isArray(operations)) throw invalidArgument('operations', 'not-an-array', 'product');

    while (this._entries.size >= VISION_LIMITS.maxProducts) {
      if (!this._evictOne()) {
        throw visionLimitExceeded(
          'maxProducts',
          this._entries.size + 1,
          VISION_LIMITS.maxProducts,
          'product store 数量超限且无可淘汰项',
        );
      }
    }
    while (this._totalBytes + bytes.length > VISION_LIMITS.maxTotalBytes) {
      if (!this._evictOne()) {
        throw visionLimitExceeded(
          'maxTotalBytes',
          this._totalBytes + bytes.length,
          VISION_LIMITS.maxTotalBytes,
          'product store 总字节超限且无可淘汰项',
        );
      }
    }

    const record = {
      productId: this._newProductId(),
      width,
      height,
      bytes,
      sha256,
      rgbaSha256,
      kind,
      mapping,
      actionable,
      parentIds: [...parentIds],
      operations: [...operations],
      createdAt,
      capturedAt,
      pins: 0,
      lastAccess: 0,
    };
    this._entries.set(record.productId, record);
    this._totalBytes += bytes.length;
    this._touch(record);
    return {
      productId: record.productId,
      width: record.width,
      height: record.height,
      bytes: record.bytes.length,
      sha256: record.sha256,
      rgbaSha256: record.rgbaSha256,
      createdAt: record.createdAt,
      capturedAt: record.capturedAt,
      kind: record.kind,
      mapping: record.mapping,
      actionable: record.actionable,
      parentIds: [...record.parentIds],
      operations: [...record.operations],
    };
  }

  get(productId) {
    if (typeof productId !== 'string') return null;
    const record = this._entries.get(productId);
    if (!record) return null;
    this._touch(record);
    return this._view(record);
  }

  pin(productId) {
    if (typeof productId !== 'string') return null;
    const record = this._entries.get(productId);
    if (!record) return null;
    record.pins += 1;
    this._touch(record);
    return this._view(record);
  }

  release(productId) {
    if (typeof productId !== 'string') return;
    const record = this._entries.get(productId);
    if (record && record.pins > 0) record.pins -= 1;
  }

  clear() {
    this._entries.clear();
    this._totalBytes = 0;
  }

  stats() {
    let pinned = 0;
    for (const record of this._entries.values()) if (record.pins > 0) pinned += 1;
    return { count: this._entries.size, bytes: this._totalBytes, pinned };
  }
}
