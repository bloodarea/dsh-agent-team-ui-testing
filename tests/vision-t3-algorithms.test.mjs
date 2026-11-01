/**
 * tests/vision-t3-algorithms.test.mjs — WEB-T3 纯算法单测（§9 U 类，无 Chromium）。
 *
 * 导出 `runAlgorithmChecks(check)`；`check(criteria, label, pass, detail)`。
 * 直接 `node tests/vision-t3-algorithms.test.mjs` 时自汇总并设置 process.exitCode。
 * import 无副作用：所有 fixture / 临时目录都在 runAlgorithmChecks 内创建，finally 清理。
 *
 * 覆盖：§9.C2（参数校验）、C6（product store）、C7（PNG 解码）、C8（PNG 编码）、
 * C9（crop/resize/mapping/预算）、C10（五种 preprocess）、C11（四类 annotation）、
 * C13（analysis 全量）、C15（连通域/排序/截断）、C16（Sobel/模板/NMS/50M 预检）、
 * C18（YIQ 黄金数值/严格阈值/透明）、C19（AA 与 includeAA/边界/tie）、C20（分母/mask/EMPTY）、
 * C21（warn/fail 等号与顺序）、C23（区域排序/过滤/截断/高亮黄金像素）、
 * C29（派生/年龄可纯测部分）、C52（预算/取消/让出事件循环/不落文件）。
 * 不覆盖（Host/验收层）：C1/C3–C5 等 B 类、C32 的完整 JSON 形状、C42/C50 的 Host 规则。
 */

import { mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';
import { constants as zlibConstants, deflateSync, inflateSync } from 'node:zlib';

import { BrowserError } from '../browser-safety.js';
import { inspectPng } from '../capture-p0.js';
import * as vision from '../vision-t3.js';

/* ------------------------------------------------------------------ */
/* 基础断言与图像工具                                                  */
/* ------------------------------------------------------------------ */

function must(condition, message) {
  if (!condition) throw new Error(message);
}

function near(actual, expected, epsilon = 1e-9) {
  return Number.isFinite(actual) && Math.abs(actual - expected) <= epsilon;
}

function expectBrowserError(fn, code) {
  try {
    fn();
  } catch (error) {
    if (error instanceof BrowserError && error.code === code) return error;
    throw new Error(`expected ${code}, got ${error && error.code ? error.code : error}`);
  }
  throw new Error(`expected ${code}, but nothing was thrown`);
}

async function expectBrowserErrorAsync(fn, code) {
  try {
    await fn();
  } catch (error) {
    if (error instanceof BrowserError && error.code === code) return error;
    throw new Error(`expected ${code}, got ${error && error.code ? error.code : error}`);
  }
  throw new Error(`expected ${code}, but nothing was thrown`);
}

function makeImage(width, height, fill = [0, 0, 0, 255]) {
  const rgba = new Uint8Array(width * height * 4);
  for (let index = 0; index < width * height; index += 1) rgba.set(fill, index * 4);
  return { width, height, rgba };
}

function cloneImage(image) {
  return { width: image.width, height: image.height, rgba: new Uint8Array(image.rgba) };
}

function setPixel(image, x, y, color) {
  const offset = (y * image.width + x) * 4;
  image.rgba[offset] = color[0];
  image.rgba[offset + 1] = color[1];
  image.rgba[offset + 2] = color[2];
  image.rgba[offset + 3] = color[3];
}

function getPixel(image, x, y) {
  const offset = (y * image.width + x) * 4;
  return [image.rgba[offset], image.rgba[offset + 1], image.rgba[offset + 2], image.rgba[offset + 3]];
}

function sameColor(actual, expected) {
  return actual.length === expected.length && expected.every((value, index) => actual[index] === value);
}

function sameRgba(left, right) {
  if (left.width !== right.width || left.height !== right.height) return false;
  if (left.rgba.length !== right.rgba.length) return false;
  for (let index = 0; index < left.rgba.length; index += 1) {
    if (left.rgba[index] !== right.rgba[index]) return false;
  }
  return true;
}

/* ------------------------------------------------------------------ */
/* 独立 PNG 构造器（测试侧，不复用被测模块）                            */
/* ------------------------------------------------------------------ */

const PNG_SIG = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);

let localCrcTable = null;
function localCrc32(bytes) {
  if (!localCrcTable) {
    localCrcTable = new Int32Array(256);
    for (let n = 0; n < 256; n += 1) {
      let c = n;
      for (let k = 0; k < 8; k += 1) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
      localCrcTable[n] = c;
    }
  }
  let c = 0xffffffff;
  for (let index = 0; index < bytes.length; index += 1) {
    c = localCrcTable[(c ^ bytes[index]) & 0xff] ^ (c >>> 8);
  }
  return (c ^ 0xffffffff) >>> 0;
}

function localChunk(type, data) {
  const typeBytes = Buffer.from(type, 'latin1');
  const body = Buffer.concat([typeBytes, data]);
  const length = Buffer.alloc(4);
  length.writeUInt32BE(data.length, 0);
  const crc = Buffer.alloc(4);
  crc.writeUInt32BE(localCrc32(body), 0);
  return Buffer.concat([length, body, crc]);
}

function buildPng({
  width,
  height,
  colorType = 6,
  bitDepth = 8,
  interlace = 0,
  rows = [],
  scanlines = null,
  idat = null,
  palette = null,
  trns = null,
  extraChunks = [],
}) {
  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(width, 0);
  ihdr.writeUInt32BE(height, 4);
  ihdr[8] = bitDepth;
  ihdr[9] = colorType;
  ihdr[10] = 0;
  ihdr[11] = 0;
  ihdr[12] = interlace;
  const parts = [PNG_SIG, localChunk('IHDR', ihdr)];
  if (palette) parts.push(localChunk('PLTE', palette));
  if (trns) parts.push(localChunk('tRNS', trns));
  for (const extra of extraChunks) parts.push(localChunk(extra.type, extra.data));
  const rawScanlines = scanlines || Buffer.concat(rows.map((row) => Buffer.concat([Buffer.from([0]), Buffer.from(row)])));
  const compressed = idat || deflateSync(rawScanlines);
  parts.push(localChunk('IDAT', compressed), localChunk('IEND', Buffer.alloc(0)));
  return Buffer.concat(parts);
}

function expectedRgbaPng(width, height, rgba) {
  const rowBytes = width * 4;
  const raw = Buffer.alloc((rowBytes + 1) * height);
  for (let y = 0; y < height; y += 1) {
    raw[y * (rowBytes + 1)] = 0;
    Buffer.from(rgba.buffer, rgba.byteOffset + y * rowBytes, rowBytes).copy(raw, y * (rowBytes + 1) + 1);
  }
  const compressed = deflateSync(raw, {
    level: 9,
    windowBits: 15,
    memLevel: 8,
    strategy: zlibConstants.Z_DEFAULT_STRATEGY,
  });
  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(width, 0);
  ihdr.writeUInt32BE(height, 4);
  ihdr[8] = 8;
  ihdr[9] = 6;
  return Buffer.concat([
    PNG_SIG,
    localChunk('IHDR', ihdr),
    localChunk('IDAT', compressed),
    localChunk('IEND', Buffer.alloc(0)),
  ]);
}

function parseChunks(png) {
  const chunks = [];
  let offset = 8;
  while (offset + 8 <= png.length) {
    const length = png.readUInt32BE(offset);
    const type = png.toString('latin1', offset + 4, offset + 8);
    const data = png.subarray(offset + 8, offset + 8 + length);
    const stored = png.readUInt32BE(offset + 8 + length);
    const actual = localCrc32(png.subarray(offset + 4, offset + 8 + length));
    chunks.push({ type, data, crcOk: stored === actual });
    offset += 12 + length;
    if (type === 'IEND') break;
  }
  return chunks;
}

function filterScanline(filterType, rawRow, previousRow, bytesPerPixel) {
  const out = new Uint8Array(rawRow.length);
  for (let index = 0; index < rawRow.length; index += 1) {
    const left = index >= bytesPerPixel ? rawRow[index - bytesPerPixel] : 0;
    const up = previousRow ? previousRow[index] : 0;
    const upLeft = previousRow && index >= bytesPerPixel ? previousRow[index - bytesPerPixel] : 0;
    let predictor;
    if (filterType === 0) predictor = 0;
    else if (filterType === 1) predictor = left;
    else if (filterType === 2) predictor = up;
    else if (filterType === 3) predictor = Math.floor((left + up) / 2);
    else {
      const p = left + up - upLeft;
      const pa = Math.abs(p - left);
      const pb = Math.abs(p - up);
      const pc = Math.abs(p - upLeft);
      predictor = pa <= pb && pa <= pc ? left : pb <= pc ? up : upLeft;
    }
    out[index] = (rawRow[index] - predictor) & 0xff;
  }
  return out;
}

function splitIdatIntoTwo(png) {
  const chunks = parseChunks(png);
  const parts = [PNG_SIG];
  for (const chunk of chunks) {
    if (chunk.type === 'IDAT') {
      const half = Math.floor(chunk.data.length / 2);
      parts.push(localChunk('IDAT', chunk.data.subarray(0, half)));
      parts.push(localChunk('IDAT', chunk.data.subarray(half)));
    } else {
      parts.push(localChunk(chunk.type, chunk.data));
    }
  }
  return Buffer.concat(parts);
}

/* ------------------------------------------------------------------ */
/* 契约 §4.2/§5 的独立参考实现（测试侧黄金口径）                        */
/* ------------------------------------------------------------------ */

function refComposite(channel, alpha) {
  return 255 + (channel - 255) * (alpha / 255);
}

function refLuma(rgba, offset) {
  const alpha = rgba[offset + 3];
  return 0.29889531 * refComposite(rgba[offset], alpha)
    + 0.58662247 * refComposite(rgba[offset + 1], alpha)
    + 0.11448223 * refComposite(rgba[offset + 2], alpha);
}

function refDelta(before, after, offset) {
  const dR = refComposite(before[offset], before[offset + 3]) - refComposite(after[offset], after[offset + 3]);
  const dG = refComposite(before[offset + 1], before[offset + 3]) - refComposite(after[offset + 1], after[offset + 3]);
  const dB = refComposite(before[offset + 2], before[offset + 3]) - refComposite(after[offset + 2], after[offset + 3]);
  const y = 0.29889531 * dR + 0.58662247 * dG + 0.11448223 * dB;
  const i = 0.59597799 * dR - 0.27417610 * dG - 0.32180189 * dB;
  const q = 0.21147017 * dR - 0.52261711 * dG + 0.31114694 * dB;
  return 0.5053 * y * y + 0.299 * i * i + 0.1957 * q * q;
}

function refEqualNeighbors(rgba, width, height, x, y) {
  const offset = (y * width + x) * 4;
  let count = 0;
  for (let ny = Math.max(0, y - 1); ny <= Math.min(height - 1, y + 1); ny += 1) {
    for (let nx = Math.max(0, x - 1); nx <= Math.min(width - 1, x + 1); nx += 1) {
      if (nx === x && ny === y) continue;
      const other = (ny * width + nx) * 4;
      if (rgba[other] === rgba[offset]
        && rgba[other + 1] === rgba[offset + 1]
        && rgba[other + 2] === rgba[offset + 2]
        && rgba[other + 3] === rgba[offset + 3]) count += 1;
    }
  }
  return count;
}

function refAaForImage(rgba, other, width, height, x, y) {
  const centerLuma = refLuma(rgba, (y * width + x) * 4);
  const border = x === 0 || y === 0 || x === width - 1 || y === height - 1;
  let equal = border ? 1 : 0;
  let darkest = null;
  let brightest = null;
  for (let ny = Math.max(0, y - 1); ny <= Math.min(height - 1, y + 1); ny += 1) {
    for (let nx = Math.max(0, x - 1); nx <= Math.min(width - 1, x + 1); nx += 1) {
      if (nx === x && ny === y) continue;
      const luma = refLuma(rgba, (ny * width + nx) * 4);
      if (luma === centerLuma) {
        equal += 1;
        if (equal > 2) return false;
      } else if (luma < centerLuma) {
        if (!darkest || luma < darkest.luma) darkest = { luma, x: nx, y: ny };
      } else if (!brightest || luma > brightest.luma) {
        brightest = { luma, x: nx, y: ny };
      }
    }
  }
  if (!darkest || !brightest) return false;
  for (const candidate of [darkest, brightest]) {
    if (refEqualNeighbors(rgba, width, height, candidate.x, candidate.y) >= 3
      && refEqualNeighbors(other, width, height, candidate.x, candidate.y) >= 3) return true;
  }
  return false;
}

function refAaPair(before, after, x, y) {
  return refAaForImage(before.rgba, after.rgba, before.width, before.height, x, y)
    || refAaForImage(after.rgba, before.rgba, before.width, before.height, x, y);
}

function refDiffCounts(before, after, options = {}) {
  const { threshold = 0.1, includeAA = false } = options;
  const limit = 35215 * threshold * threshold;
  let diffPixels = 0;
  let aaPixels = 0;
  for (let y = 0; y < before.height; y += 1) {
    for (let x = 0; x < before.width; x += 1) {
      const offset = (y * before.width + x) * 4;
      if (refDelta(before.rgba, after.rgba, offset) > limit) {
        if (!includeAA && refAaPair(before, after, x, y)) aaPixels += 1;
        else diffPixels += 1;
      }
    }
  }
  return { diffPixels, aaPixels };
}

function refBlur(image, radius) {
  const { width, height } = image;
  const source = image.rgba;
  const out = new Uint8Array(source.length);
  const count = (2 * radius + 1) * (2 * radius + 1);
  for (let y = 0; y < height; y += 1) {
    for (let x = 0; x < width; x += 1) {
      let sumA = 0;
      let sumR = 0;
      let sumG = 0;
      let sumB = 0;
      for (let dy = -radius; dy <= radius; dy += 1) {
        const sy = Math.min(height - 1, Math.max(0, y + dy));
        for (let dx = -radius; dx <= radius; dx += 1) {
          const sx = Math.min(width - 1, Math.max(0, x + dx));
          const offset = (sy * width + sx) * 4;
          const alpha = source[offset + 3];
          sumA += alpha;
          sumR += source[offset] * alpha;
          sumG += source[offset + 1] * alpha;
          sumB += source[offset + 2] * alpha;
        }
      }
      const offset = (y * width + x) * 4;
      if (sumA <= 0) continue;
      out[offset] = Math.max(0, Math.min(255, Math.round(sumR / sumA)));
      out[offset + 1] = Math.max(0, Math.min(255, Math.round(sumG / sumA)));
      out[offset + 2] = Math.max(0, Math.min(255, Math.round(sumB / sumA)));
      out[offset + 3] = Math.max(0, Math.min(255, Math.round(sumA / count)));
    }
  }
  return { width, height, rgba: out };
}

function refBilinear(image, factor) {
  const widthIn = image.width;
  const heightIn = image.height;
  const widthOut = Math.round(widthIn * factor);
  const heightOut = Math.round(heightIn * factor);
  const out = new Uint8Array(widthOut * heightOut * 4);
  for (let oy = 0; oy < heightOut; oy += 1) {
    const v = ((oy + 0.5) * heightIn) / heightOut - 0.5;
    const y0 = Math.floor(v);
    const fy = v - y0;
    const ya = Math.min(heightIn - 1, Math.max(0, y0));
    const yb = Math.min(heightIn - 1, Math.max(0, y0 + 1));
    for (let ox = 0; ox < widthOut; ox += 1) {
      const u = ((ox + 0.5) * widthIn) / widthOut - 0.5;
      const x0 = Math.floor(u);
      const fx = u - x0;
      const xa = Math.min(widthIn - 1, Math.max(0, x0));
      const xb = Math.min(widthIn - 1, Math.max(0, x0 + 1));
      const points = [
        [xa, ya, (1 - fx) * (1 - fy)],
        [xb, ya, fx * (1 - fy)],
        [xa, yb, (1 - fx) * fy],
        [xb, yb, fx * fy],
      ];
      let aSum = 0;
      for (const [px, py, weight] of points) aSum += weight * image.rgba[(py * widthIn + px) * 4 + 3];
      const offset = (oy * widthOut + ox) * 4;
      if (aSum <= 0) continue;
      for (let channel = 0; channel < 3; channel += 1) {
        let sum = 0;
        for (const [px, py, weight] of points) {
          const source = image.rgba[(py * widthIn + px) * 4 + channel];
          const alpha = image.rgba[(py * widthIn + px) * 4 + 3];
          sum += weight * alpha * source;
        }
        out[offset + channel] = Math.max(0, Math.min(255, Math.round(sum / aSum)));
      }
      out[offset + 3] = Math.max(0, Math.min(255, Math.round(aSum)));
    }
  }
  return { width: widthOut, height: heightOut, rgba: out };
}

function makeMapping(overrides = {}) {
  return {
    coordinateSpace: 'document-css-px',
    originCss: { x: 10, y: 20 },
    cssPerPixel: { x: 0.5, y: 0.5 },
    imagePixels: { width: 100, height: 100 },
    capturedCssRect: { x: 10, y: 20, width: 50, height: 50 },
    scrollAtCapture: { x: 0, y: 0 },
    viewportAtCapture: { width: 1280, height: 800 },
    visualViewportScale: null,
    geometryTransform: 'axis-aligned',
    ...overrides,
  };
}

/* ------------------------------------------------------------------ */
/* 主入口                                                              */
/* ------------------------------------------------------------------ */

export async function runAlgorithmChecks(check) {
  const emit = (criteria, label, pass, detail) => check(
    criteria,
    label,
    pass === true,
    detail === undefined ? null : detail,
  );
  const t = async (criteria, label, fn) => {
    try {
      const result = await fn();
      if (result === undefined || result === true) await emit(criteria, label, true, null);
      else await emit(criteria, label, result.pass === true, result.detail === undefined ? null : result.detail);
    } catch (error) {
      await emit(criteria, label, false, {
        error: error && error.message ? error.message : String(error),
        code: error && error.code ? error.code : null,
      });
    }
  };

  const tempRoot = mkdtempSync(join(tmpdir(), 'dsh-t3-vision-test-'));
  try {
    /* ---------------- §9.C2 参数校验 ---------------- */
    await t('§9.C2', 'validators 拒绝未知字段/非有限数/类型转换/非法 Name 并返回规范值', () => {
      expectBrowserError(() => vision.validateSource({ kind: 'live', path: '/tmp/x.png' }), 'INVALID_ARGUMENT');
      expectBrowserError(() => vision.validateSource({ kind: 'product', productId: 'v1_XYZ' }), 'INVALID_ARGUMENT');
      expectBrowserError(() => vision.validateSource({ kind: 'product', productId: 'v1_' + 'A'.repeat(32) }), 'INVALID_ARGUMENT');
      expectBrowserError(() => vision.validateSource({ kind: 'baseline', name: 'bad name' }), 'INVALID_ARGUMENT');
      expectBrowserError(() => vision.validatePixelRect({ x: 0, y: 0, width: 1.5, height: 1 }), 'INVALID_ARGUMENT');
      expectBrowserError(() => vision.validatePixelRect({ x: 0, y: 0, width: 0, height: 1 }), 'INVALID_ARGUMENT');
      expectBrowserError(() => vision.validateCssRect({ x: 0, y: 0, width: 0.5, height: 1 }), 'INVALID_ARGUMENT');
      expectBrowserError(() => vision.validatePoint({ x: -1, y: 0 }), 'INVALID_ARGUMENT');
      expectBrowserError(() => vision.validatePoint({ x: Number.NaN, y: 0 }), 'INVALID_ARGUMENT');
      expectBrowserError(() => vision.validateQuery({ method: 'color', color: [1, 2, 3], tolerance: 1.5 }), 'INVALID_ARGUMENT');
      expectBrowserError(() => vision.validateQuery({ method: 'color', color: [1, 2, 3], minArea: 1, background: [0, 0, 0] }), 'INVALID_ARGUMENT');
      expectBrowserError(() => vision.validateQuery({ method: 'template', template: { kind: 'product', productId: 'v1_' + 'a'.repeat(32) }, minArea: 1 }), 'INVALID_ARGUMENT');
      expectBrowserError(() => vision.validateQuery({ method: 'template', template: { kind: 'live' } }), 'INVALID_ARGUMENT');
      expectBrowserError(() => vision.validateDiffOptions({ threshold: 1.1 }), 'INVALID_ARGUMENT');
      expectBrowserError(() => vision.validateDiffOptions({ threshold: '0.1' }), 'INVALID_ARGUMENT');
      expectBrowserError(() => vision.validateThresholds({ warnRatio: 0.02, failRatio: 0.01 }), 'INVALID_ARGUMENT');
      expectBrowserError(() => vision.validateMasks([{ id: 'a', region: { x: 0, y: 0, width: 1, height: 1 } }, { id: 'a', region: { x: 0, y: 0, width: 1, height: 1 } }]), 'INVALID_ARGUMENT');
      expectBrowserError(() => vision.validateAnnotations([{ kind: 'rect', region: { x: 0, y: 0, width: 1, height: 1 }, point: { x: 0, y: 0 } }]), 'INVALID_ARGUMENT');
      expectBrowserError(() => vision.validateAnnotations([{ kind: 'cross' }]), 'INVALID_ARGUMENT');
      expectBrowserError(() => vision.validateAnnotations([{ kind: 'number', point: { x: 0, y: 0 }, number: 0 }]), 'INVALID_ARGUMENT');
      expectBrowserError(() => vision.validatePreprocess([{ op: 'grayscale', radius: 1 }]), 'INVALID_ARGUMENT');
      expectBrowserError(() => vision.validatePreprocess([{ op: 'blur', radius: 4 }]), 'INVALID_ARGUMENT');
      expectBrowserError(() => vision.validateOutput({ persist: 'true' }), 'INVALID_ARGUMENT');
      expectBrowserError(() => vision.validateOutput({ out: '' }), 'INVALID_ARGUMENT');
      expectBrowserError(() => vision.validateOutput({ out: 'a.png', extra: 1 }), 'INVALID_ARGUMENT');
      const source = vision.validateSource({ kind: 'live', scale: 1.25, region: { x: 1.5, y: 2, width: 10.25, height: 5 } });
      must(source.kind === 'live' && source.scale === 1.25 && source.region.width === 10.25, 'live source normalization');
      must(vision.validateSource({ kind: 'live' }).region === undefined, 'absent live region stays absent');
      const query = vision.validateQuery({ method: 'color', color: [255, 0, 0] });
      must(query.minArea === 4 && query.maxResults === 20 && query.tolerance === 16, 'query defaults');
      const options = vision.validateDiffOptions(undefined);
      must(options.threshold === 0.1 && options.includeAA === false && options.minRegionPixels === 1, 'diff defaults');
      const thresholds = vision.validateThresholds(undefined);
      must(thresholds.warnRatio === 0.001 && thresholds.failRatio === 0.01, 'threshold defaults');
      const masks = vision.validateMasks(undefined);
      must(Array.isArray(masks) && masks.length === 0, 'masks default []');
      const annotations = vision.validateAnnotations([{ kind: 'cross', point: { x: 1, y: 2 } }]);
      must(annotations[0].size === 9 && annotations[0].thickness === 2, 'annotation defaults');
      must(sameColor(annotations[0].color, [255, 0, 0, 255]), 'annotation default color');
      const preprocess = vision.validatePreprocess([{ op: 'blur' }, { op: 'threshold' }, { op: 'channels' }]);
      must(preprocess[0].radius === 1 && preprocess[1].value === 128 && preprocess[2].order === 'rgba', 'preprocess defaults');
      const output = vision.validateOutput(undefined);
      must(output.persist === false && output.out === undefined, 'output default');
      // 规范化结果可再次校验（幂等），便于 Host 二次传递。
      must(vision.validateSource(vision.validateSource({ kind: 'live' })).kind === 'live', 'source normalization idempotent');
      must(vision.validateSource(vision.validateSource({ kind: 'baseline', name: 'b1' })).name === 'b1', 'baseline normalization idempotent');
      must(vision.validateOutput(vision.validateOutput({ persist: true, out: 'a.png' })).persist === true, 'output normalization idempotent');
      must(vision.validateQuery(vision.validateQuery({ method: 'template', template: { kind: 'product', productId: 'v1_' + 'a'.repeat(32) } })).method === 'template', 'query normalization idempotent');
      must(vision.validateAnnotations(vision.validateAnnotations([{ kind: 'cross', point: { x: 1, y: 1 } }])).length === 1, 'annotations normalization idempotent');
      // 错误不回声值原文：只带 path/reason。
      try {
        vision.validateSource({ kind: 'product', productId: 'v1_LEAKME' });
        must(false, 'expected throw');
      } catch (error) {
        must(error.details && error.details.path === 'source.productId', 'error path');
        must(error.details && error.details.reason === 'invalid-product-id', 'error reason');
        must(!error.message.includes('LEAKME'), 'error must not echo the value');
      }
      return true;
    });

    /* ---------------- §9.C6 product store ---------------- */
    await t('§9.C6', 'store 16 项限额 + LRU 读刷新 + pin 不可淘汰', () => {
      const store = new vision.VisionProductStore({ now: () => 1000 });
      const products = [];
      for (let index = 0; index < 16; index += 1) {
        products.push(store.add({
          bytes: Buffer.from([index, index + 1, index + 2]),
          width: 1,
          height: 1,
          kind: 'capture',
          actionable: true,
          capturedAt: 900 + index,
        }));
      }
      must(store.stats().count === 16, 'store holds 16');
      must(/^v1_[0-9a-f]{32}$/.test(products[0].productId), 'product id format');
      must(products[0].productId !== products[1].productId, 'product ids unique');
      must(products[0].bytes === 3, 'product bytes is a length');
      must(products[0].createdAt === 1000 && products[0].capturedAt === 900, 'product timestamps');
      // 读刷新：get(products[0]) 后最旧项变成 products[1]。
      must(store.get(products[0].productId) !== null, 'get oldest');
      const added = store.add({ bytes: Buffer.from([9, 9, 9, 9]), width: 1, height: 1, kind: 'derived', actionable: false });
      must(store.stats().count === 16, 'evicted to 16');
      must(store.get(products[0].productId) !== null, 'read-refreshed product survives');
      must(store.get(products[1].productId) === null, 'second-oldest evicted');
      must(store.get(added.productId) !== null, 'new product present');
      // pin 不淘汰。
      const store2 = new vision.VisionProductStore();
      const pinned = store2.add({ bytes: Buffer.from([1]), width: 1, height: 1, kind: 'capture', actionable: true });
      must(store2.pin(pinned.productId) !== null, 'pin existing');
      must(store2.pin(pinned.productId).pinned === true, 'pinned flag');
      for (let index = 0; index < 15; index += 1) {
        store2.add({ bytes: Buffer.from([index + 2]), width: 1, height: 1, kind: 'capture', actionable: true });
      }
      must(store2.stats().count === 16, 'store2 full');
      must(store2.stats().pinned === 1, 'one pinned');
      const extra = store2.add({ bytes: Buffer.from([200]), width: 1, height: 1, kind: 'derived', actionable: false });
      must(store2.get(pinned.productId) !== null, 'pinned survives eviction');
      must(store2.get(extra.productId) !== null, 'extra added');
      // 全部 pin 后拒绝。
      const store3 = new vision.VisionProductStore();
      for (let index = 0; index < 16; index += 1) {
        const product = store3.add({ bytes: Buffer.from([index]), width: 1, height: 1, kind: 'capture', actionable: true });
        store3.pin(product.productId);
      }
      const error = expectBrowserError(
        () => store3.add({ bytes: Buffer.from([99]), width: 1, height: 1, kind: 'capture', actionable: true }),
        'VISION_LIMIT_EXCEEDED',
      );
      must(error.details.limit === 'maxProducts' && error.details.max === 16, 'maxProducts details');
      // 单张字节/像素限额。
      const bigBytes = Buffer.alloc(vision.VISION_LIMITS.maxProductBytes + 1);
      const bytesError = expectBrowserError(
        () => new vision.VisionProductStore().add({ bytes: bigBytes, width: 1, height: 1, kind: 'capture', actionable: true }),
        'VISION_LIMIT_EXCEEDED',
      );
      must(bytesError.details.limit === 'maxProductBytes' && bytesError.details.max === 32 * 1024 * 1024, 'maxProductBytes details');
      const pixelError = expectBrowserError(
        () => new vision.VisionProductStore().add({ bytes: Buffer.from([1]), width: 5000, height: 4000, kind: 'capture', actionable: true }),
        'VISION_LIMIT_EXCEEDED',
      );
      must(pixelError.details.limit === 'maxProductPixels' && pixelError.details.actual === 20000000, 'maxProductPixels details');
      // 总量限额：4×30MiB pin 住后加 9MiB。
      const store4 = new vision.VisionProductStore();
      for (let index = 0; index < 4; index += 1) {
        const product = store4.add({
          bytes: Buffer.alloc(30 * 1024 * 1024),
          width: 1,
          height: 1,
          kind: 'capture',
          actionable: true,
        });
        store4.pin(product.productId);
      }
      const totalError = expectBrowserError(
        () => store4.add({ bytes: Buffer.alloc(9 * 1024 * 1024), width: 1, height: 1, kind: 'capture', actionable: true }),
        'VISION_LIMIT_EXCEEDED',
      );
      must(totalError.details.limit === 'maxTotalBytes' && totalError.details.max === 128 * 1024 * 1024, 'maxTotalBytes details');
      // 缺失/淘汰/重启：pin/get 返回 null，release/clear/stats。
      must(store2.pin('v1_' + 'f'.repeat(32)) === null, 'pin missing -> null');
      must(store2.get('v1_' + 'f'.repeat(32)) === null, 'get missing -> null');
      store2.release(pinned.productId);
      store2.release(pinned.productId);
      must(store2.stats().pinned === 0, 'release clears pin');
      const restarted = new vision.VisionProductStore();
      must(restarted.get(pinned.productId) === null, 'restart invalidates ids');
      store2.clear();
      must(store2.stats().count === 0 && store2.stats().bytes === 0, 'clear empties store');
      return true;
    });

    /* ---------------- §9.C7 PNG 解码 ---------------- */
    await t('§9.C7', 'RGBA/GA/RGB/G 通道正规化 + 格式拒绝', () => {
      const rgbaPng = buildPng({
        width: 2,
        height: 2,
        colorType: 6,
        rows: [
          [255, 0, 0, 255, 0, 255, 0, 128],
          [0, 0, 255, 0, 10, 20, 30, 255],
        ],
      });
      const rgba = vision.decodePngToRgba(rgbaPng);
      must(rgba.ok === true && rgba.width === 2 && rgba.height === 2, 'rgba decode dims');
      must(sameColor(getPixel(rgba, 0, 0), [255, 0, 0, 255]), 'rgba pixel 00');
      must(sameColor(getPixel(rgba, 1, 0), [0, 255, 0, 128]), 'rgba pixel 10');
      must(sameColor(getPixel(rgba, 1, 1), [10, 20, 30, 255]), 'rgba pixel 11');
      const gray = vision.decodePngToRgba(buildPng({
        width: 2,
        height: 1,
        colorType: 0,
        rows: [[0, 200]],
      }));
      must(gray.ok === true, 'gray decode');
      must(sameColor(getPixel(gray, 0, 0), [0, 0, 0, 255]), 'gray 0 -> rgba');
      must(sameColor(getPixel(gray, 1, 0), [200, 200, 200, 255]), 'gray 200 -> rgba');
      const grayAlpha = vision.decodePngToRgba(buildPng({
        width: 2,
        height: 1,
        colorType: 4,
        rows: [[10, 0, 20, 255]],
      }));
      must(grayAlpha.ok === true, 'ga decode');
      must(sameColor(getPixel(grayAlpha, 0, 0), [10, 10, 10, 0]), 'ga alpha 0');
      must(sameColor(getPixel(grayAlpha, 1, 0), [20, 20, 20, 255]), 'ga alpha 255');
      const rgb = vision.decodePngToRgba(buildPng({
        width: 1,
        height: 1,
        colorType: 2,
        rows: [[1, 2, 3]],
      }));
      must(rgb.ok === true, 'rgb decode');
      must(sameColor(getPixel(rgb, 0, 0), [1, 2, 3, 255]), 'rgb alpha 255');
      // 不支持格式：palette / 16-bit / interlace / tRNS。
      const palette = vision.decodePngToRgba(buildPng({
        width: 1,
        height: 1,
        colorType: 3,
        rows: [[0]],
        palette: Buffer.from([255, 0, 0, 0, 255, 0]),
      }));
      must(palette.ok === false && palette.code === 'VISION_FORMAT_UNSUPPORTED', 'palette unsupported');
      const deep = vision.decodePngToRgba(buildPng({
        width: 1,
        height: 1,
        colorType: 6,
        bitDepth: 16,
        rows: [new Array(8).fill(0)],
      }));
      must(deep.ok === false && deep.code === 'VISION_FORMAT_UNSUPPORTED', '16-bit unsupported');
      const interlaced = vision.decodePngToRgba(buildPng({
        width: 1,
        height: 1,
        colorType: 6,
        interlace: 1,
        rows: [[1, 2, 3, 4]],
      }));
      must(interlaced.ok === false && interlaced.code === 'VISION_FORMAT_UNSUPPORTED', 'interlace unsupported');
      const withTrns = vision.decodePngToRgba(buildPng({
        width: 1,
        height: 1,
        colorType: 2,
        rows: [[1, 2, 3]],
        trns: Buffer.from([0, 1, 0, 2, 0, 3]),
      }));
      must(withTrns.ok === false && withTrns.code === 'VISION_FORMAT_UNSUPPORTED', 'tRNS unsupported');
      return true;
    });

    await t('§9.C7', 'filter 0–4 与非交错多 IDAT 解码正确', () => {
      const width = 4;
      const height = 5;
      const original = makeImage(width, height);
      for (let y = 0; y < height; y += 1) {
        for (let x = 0; x < width; x += 1) setPixel(original, x, y, [x * 50, y * 40, (x + y) * 20, 200 + x]);
      }
      const scanlineParts = [];
      for (let y = 0; y < height; y += 1) {
        const filterType = y % 5; // 0,1,2,3,4 各一次
        const row = original.rgba.subarray(y * width * 4, (y + 1) * width * 4);
        const previous = y > 0 ? original.rgba.subarray((y - 1) * width * 4, y * width * 4) : null;
        scanlineParts.push(Buffer.concat([Buffer.from([filterType]), Buffer.from(filterScanline(filterType, row, previous, 4))]));
      }
      const filtered = buildPng({ width, height, colorType: 6, scanlines: Buffer.concat(scanlineParts) });
      const decoded = vision.decodePngToRgba(filtered);
      must(decoded.ok === true, 'filtered PNG decodes');
      must(sameRgba(decoded, original), 'filter 0-4 decode matches original pixels');
      const multiIdat = splitIdatIntoTwo(vision.encodePngRgba(original));
      const chunks = parseChunks(multiIdat);
      must(chunks.filter((chunk) => chunk.type === 'IDAT').length === 2, 'two IDAT chunks built');
      const decodedMulti = vision.decodePngToRgba(multiIdat);
      must(decodedMulti.ok === true && sameRgba(decodedMulti, original), 'multi-IDAT decode');
      return true;
    });

    await t('§9.C7', 'CRC 错/截断/非 PNG/压缩炸弹/长度不符拒绝且不伪造分析', () => {
      const valid = buildPng({ width: 2, height: 2, colorType: 6, rows: [[1, 2, 3, 4, 5, 6, 7, 8], [9, 10, 11, 12, 13, 14, 15, 16]] });
      const corrupted = Buffer.from(valid);
      corrupted[16] ^= 0xff; // IHDR data 首字节 -> CRC 不符
      const crc = vision.decodePngToRgba(corrupted);
      must(crc.ok === false && crc.code === 'INVALID_PNG', 'CRC mismatch -> INVALID_PNG');
      const truncated = vision.decodePngToRgba(valid.subarray(0, valid.length - 10));
      must(truncated.ok === false && truncated.code === 'INVALID_PNG', 'truncated -> INVALID_PNG');
      const notPng = vision.decodePngToRgba(Buffer.from('not a png'));
      must(notPng.ok === false && notPng.code === 'INVALID_PNG', 'not png -> INVALID_PNG');
      const bomb = buildPng({
        width: 2,
        height: 2,
        colorType: 6,
        idat: deflateSync(Buffer.alloc(1024 * 1024)),
      });
      const bombResult = vision.decodePngToRgba(bomb);
      must(bombResult.ok === false && bombResult.code === 'INVALID_PNG', 'compression bomb rejected');
      must(bombResult.width === undefined && bombResult.rgba === undefined, 'no fake analysis on failure');
      const wrongLength = buildPng({
        width: 2,
        height: 2,
        colorType: 6,
        idat: deflateSync(Buffer.alloc(18 + 5)),
      });
      const wrong = vision.decodePngToRgba(wrongLength);
      must(wrong.ok === false && wrong.code === 'INVALID_PNG', 'wrong scanline length -> INVALID_PNG');
      // 文件 roundtrip（临时目录，不写仓库 output/）。
      const file = join(tempRoot, 'decode-roundtrip.png');
      writeFileSync(file, valid);
      const fromFile = vision.decodePngToRgba(readFileSync(file));
      must(fromFile.ok === true && fromFile.width === 2, 'decode from file');
      return true;
    });

    /* ---------------- §9.C8 PNG 编码 ---------------- */
    await t('§9.C8', '编码确定性 + 结构/CRC/filter0/单 IDAT/无 tIME + 黄金字节', () => {
      const images = [
        makeImage(1, 1, [255, 0, 0, 255]),
        makeImage(3, 2, [0, 0, 0, 0]),
        { width: 4, height: 1, rgba: Uint8Array.from([255, 0, 0, 255, 0, 255, 0, 255, 0, 0, 255, 255, 255, 255, 255, 255]) },
        { width: 2, height: 2, rgba: Uint8Array.from([10, 20, 30, 40, 50, 60, 70, 80, 90, 100, 110, 120, 130, 140, 150, 160]) },
      ];
      for (const image of images) {
        const first = vision.encodePngRgba(image);
        const second = vision.encodePngRgba(image);
        must(Buffer.compare(first, second) === 0, 'same image encodes identical bytes');
        const expected = expectedRgbaPng(image.width, image.height, image.rgba);
        must(Buffer.compare(first, expected) === 0, 'golden bytes (chunk layout + CRC + deflate)');
        const inspected = inspectPng(first);
        must(inspected.ok === true && inspected.width === image.width && inspected.height === image.height, 'P0 inspect passes');
        const chunks = parseChunks(first);
        must(chunks.map((chunk) => chunk.type).join(',') === 'IHDR,IDAT,IEND', 'single IHDR/IDAT/IEND');
        must(chunks.every((chunk) => chunk.crcOk), 'all chunk CRCs valid');
        must(chunks[0].data[8] === 8 && chunks[0].data[9] === 6, 'IHDR bitDepth 8 / colorType 6');
        must(chunks[0].data[10] === 0 && chunks[0].data[11] === 0 && chunks[0].data[12] === 0, 'IHDR compression/filter/interlace 0');
        const inflated = inflateSync(chunks[1].data);
        must(inflated.length === (image.width * 4 + 1) * image.height, 'IDAT inflates to expected length');
        for (let y = 0; y < image.height; y += 1) {
          must(inflated[y * (image.width * 4 + 1)] === 0, 'scanline filter 0');
        }
        const decoded = vision.decodePngToRgba(first);
        must(decoded.ok === true && sameRgba(decoded, image), 'roundtrip pixels');
      }
      // 输出像素限额先于 rgba 校验。
      const limit = expectBrowserError(
        () => vision.encodePngRgba({ width: 5000, height: 4000, rgba: new Uint8Array(0) }),
        'VISION_LIMIT_EXCEEDED',
      );
      must(limit.details.limit === 'maxOutputPixels' && limit.details.actual === 20000000, 'encode pixel limit details');
      expectBrowserError(() => vision.encodePngRgba({ width: 1, height: 1, rgba: new Uint8Array(3) }), 'INVALID_ARGUMENT');
      return true;
    });

    /* ---------------- §9.C9 crop/resize/mapping ---------------- */
    await t('§9.C9', 'crop 像素精确 + 越界拒绝', () => {
      const source = makeImage(4, 4);
      for (let y = 0; y < 4; y += 1) {
        for (let x = 0; x < 4; x += 1) setPixel(source, x, y, [x * 10, y * 10, x + y, 255]);
      }
      const cropped = vision.cropImage(source, { x: 1, y: 1, width: 2, height: 2 });
      must(cropped.width === 2 && cropped.height === 2, 'crop dims');
      must(sameColor(getPixel(cropped, 0, 0), [10, 10, 2, 255]), 'crop 00');
      must(sameColor(getPixel(cropped, 1, 1), [20, 20, 4, 255]), 'crop 11');
      expectBrowserError(() => vision.cropImage(source, { x: 3, y: 0, width: 2, height: 1 }), 'INVALID_ARGUMENT');
      expectBrowserError(() => vision.cropImage(source, { x: 0.5, y: 0, width: 1, height: 1 }), 'INVALID_ARGUMENT');
      return true;
    });

    await t('§9.C9', 'nearest 公式（factor 1.25）与 bilinear 预乘 alpha', () => {
      const source = makeImage(4, 3);
      for (let y = 0; y < 3; y += 1) {
        for (let x = 0; x < 4; x += 1) setPixel(source, x, y, [x * 40, y * 40, (x + y) * 10, 255]);
      }
      const nearest = vision.resizeImage(source, 1.25, 'nearest');
      must(nearest.width === 5 && nearest.height === 4, 'nearest dims round(4*1.25)=5 / round(3*1.25)=4');
      for (let oy = 0; oy < 4; oy += 1) {
        const iy = Math.min(2, Math.floor(((oy + 0.5) * 3) / 4));
        for (let ox = 0; ox < 5; ox += 1) {
          const ix = Math.min(3, Math.floor(((ox + 0.5) * 4) / 5));
          must(sameColor(getPixel(nearest, ox, oy), getPixel(source, ix, iy)), `nearest formula at ${ox},${oy}`);
        }
      }
      const half = {
        width: 2,
        height: 1,
        rgba: Uint8Array.from([255, 0, 0, 128, 0, 0, 255, 128]),
      };
      const bilinear = vision.resizeImage(half, 2, 'bilinear');
      must(bilinear.width === 4 && bilinear.height === 2, 'bilinear dims');
      must(sameColor(getPixel(bilinear, 0, 0), [255, 0, 0, 128]), 'bilinear left edge keeps red');
      must(sameColor(getPixel(bilinear, 1, 0), [191, 0, 64, 128]), 'bilinear premultiplied interior');
      must(sameColor(getPixel(bilinear, 3, 0), [0, 0, 255, 128]), 'bilinear right edge keeps blue');
      const reference = refBilinear(half, 2);
      must(sameRgba(bilinear, reference), 'bilinear matches independent reference');
      const odd = makeImage(3, 3, [12, 34, 56, 200]);
      const oddResized = vision.resizeImage(odd, 1.5, 'bilinear');
      must(oddResized.width === 5 && oddResized.height === 5, 'odd dims round(3*1.5)=5');
      expectBrowserError(() => vision.resizeImage(source, 0.5), 'INVALID_ARGUMENT');
      expectBrowserError(() => vision.resizeImage(source, 5), 'INVALID_ARGUMENT');
      expectBrowserError(() => vision.resizeImage(source, 1, 'bicubic'), 'INVALID_ARGUMENT');
      return true;
    });

    await t('§9.C9', 'resize 输出 16M 像素预算', () => {
      const big = makeImage(2000, 2000, [0, 0, 0, 255]);
      const error = expectBrowserError(() => vision.resizeImage(big, 2.1), 'VISION_LIMIT_EXCEEDED');
      must(error.details.limit === 'maxOutputPixels' && error.details.actual === 4200 * 4200, 'resize output pixel limit');
      return true;
    });

    await t('§9.C9', 'crop/resize 后 mapping 原点与实际 sx/sy + 矩形边缘映射', () => {
      const mapping = makeMapping();
      const cropped = vision.mappingAfterCrop(mapping, { x: 10, y: 20, width: 30, height: 40 });
      must(near(cropped.originCss.x, 15) && near(cropped.originCss.y, 30), 'crop origin += crop*px');
      must(cropped.imagePixels.width === 30 && cropped.imagePixels.height === 40, 'crop imagePixels');
      must(near(cropped.capturedCssRect.width, 15) && near(cropped.capturedCssRect.height, 20), 'crop capturedCssRect');
      const resized = vision.mappingAfterResize(cropped, 60, 80);
      must(near(resized.cssPerPixel.x, 0.25) && near(resized.cssPerPixel.y, 0.25), 'resize cssPerPixel / sx=sy=2');
      const nonUniform = vision.mappingAfterResize(mapping, 200, 50);
      must(near(nonUniform.cssPerPixel.x, 0.25) && near(nonUniform.cssPerPixel.y, 1), 'non-uniform sx/sy');
      const rect = vision.mapImageRectToDocument(mapping, { x: 0, y: 0, width: 100, height: 100 });
      must(near(rect.x, 10) && near(rect.y, 20) && near(rect.width, 50) && near(rect.height, 50), 'rect uses edges');
      const point = vision.mapImagePointToDocument(mapping, { x: 20, y: 40 });
      must(near(point.x, 20) && near(point.y, 40), 'point mapping');
      must(vision.mapImagePointToDocument(null, { x: 0, y: 0 }) === null, 'no mapping -> null');
      return true;
    });

    /* ---------------- §9.C10 preprocess ---------------- */
    await t('§9.C10', 'grayscale/threshold/channels 公式与 alpha', () => {
      const source = {
        width: 3,
        height: 1,
        rgba: Uint8Array.from([255, 0, 0, 7, 0, 255, 0, 8, 10, 20, 30, 9]),
      };
      const gray = vision.preprocessImage(source, [{ op: 'grayscale' }]);
      must(sameColor(getPixel(gray, 0, 0), [76, 76, 76, 7]), 'grayscale red -> 76');
      must(sameColor(getPixel(gray, 1, 0), [150, 150, 150, 8]), 'grayscale green -> 150');
      must(sameColor(getPixel(gray, 2, 0), [18, 18, 18, 9]), 'grayscale mixed -> 18');
      const thresholded = vision.preprocessImage(source, [{ op: 'threshold', value: 128 }]);
      must(sameColor(getPixel(thresholded, 0, 0), [0, 0, 0, 7]), 'threshold 76 < 128 -> 0');
      must(sameColor(getPixel(thresholded, 1, 0), [255, 255, 255, 8]), 'threshold 150 >= 128 -> 255');
      const channels = vision.preprocessImage(source, [{ op: 'channels', order: 'argb' }]);
      must(sameColor(getPixel(channels, 0, 0), [7, 255, 0, 0]), 'argb changes alpha channel');
      const bgra = vision.preprocessImage(source, [{ op: 'channels', order: 'bgra' }]);
      must(sameColor(getPixel(bgra, 2, 0), [30, 20, 10, 9]), 'bgra swaps r/b');
      const identity = vision.preprocessImage(source, [{ op: 'channels', order: 'rgba' }]);
      must(sameRgba(identity, source), 'rgba identity');
      return true;
    });

    await t('§9.C10', 'blur 边缘 clamp/预乘 alpha 与 normalize 公式', () => {
      const source = {
        width: 3,
        height: 3,
        rgba: Uint8Array.from([
          100, 0, 0, 255, 0, 100, 0, 255, 0, 0, 100, 255,
          255, 255, 0, 128, 0, 0, 0, 0, 200, 100, 50, 64,
          10, 20, 30, 255, 40, 50, 60, 255, 70, 80, 90, 255,
        ]),
      };
      const blurred = vision.preprocessImage(source, [{ op: 'blur', radius: 1 }]);
      must(sameRgba(blurred, refBlur(source, 1)), 'blur radius 1 matches reference');
      const blurred3 = vision.preprocessImage(source, [{ op: 'blur', radius: 3 }]);
      must(sameRgba(blurred3, refBlur(source, 3)), 'blur radius 3 matches reference');
      const normalized = vision.preprocessImage(source, [{ op: 'normalize' }]);
      // alpha>0 像素各通道 min/max：r min=0 max=255、g min=0 max=255、b min=0 max=100。
      must(sameColor(getPixel(normalized, 0, 0), [100, 0, 0, 255]), 'normalize keeps r=100 when min=0/max=255');
      must(sameColor(getPixel(normalized, 2, 2), [70, 80, 230, 255]), 'normalize b 90 -> round(255*90/100)=230');
      must(sameColor(getPixel(normalized, 1, 1), [0, 0, 0, 0]), 'normalize leaves alpha=0 pixel');
      const transparent = makeImage(2, 2, [10, 20, 30, 0]);
      must(sameRgba(vision.preprocessImage(transparent, [{ op: 'normalize' }]), transparent), 'all-transparent normalize unchanged');
      return true;
    });

    await t('§9.C10', 'preprocess 顺序生效（顺序交换结果不同）', () => {
      const source = { width: 1, height: 1, rgba: Uint8Array.from([10, 20, 30, 40]) };
      const first = vision.preprocessImage(source, [{ op: 'grayscale' }, { op: 'channels', order: 'argb' }]);
      const second = vision.preprocessImage(source, [{ op: 'channels', order: 'argb' }, { op: 'grayscale' }]);
      must(!sameRgba(first, second), 'order changes the result');
      must(sameColor(getPixel(first, 0, 0), [40, 18, 18, 18]), 'grayscale then argb');
      must(sameColor(getPixel(second, 0, 0), [20, 20, 20, 30]), 'argb then grayscale');
      return true;
    });

    /* ---------------- §9.C11 annotation ---------------- */
    await t('§9.C11', 'rect/cross 黄金像素 + thickness 偶数扩张方向', () => {
      const canvas = makeImage(8, 8, [255, 255, 255, 255]);
      const rect = vision.annotateImage(canvas, [{ kind: 'rect', region: { x: 1, y: 1, width: 5, height: 5 }, color: [255, 0, 0, 255], thickness: 1 }]);
      must(sameColor(getPixel(rect, 1, 1), [255, 0, 0, 255]), 'rect top-left');
      must(sameColor(getPixel(rect, 5, 1), [255, 0, 0, 255]), 'rect top-right');
      must(sameColor(getPixel(rect, 3, 1), [255, 0, 0, 255]), 'rect top edge');
      must(sameColor(getPixel(rect, 1, 3), [255, 0, 0, 255]), 'rect left edge');
      must(sameColor(getPixel(rect, 3, 3), [255, 255, 255, 255]), 'rect interior untouched');
      const even = vision.annotateImage(makeImage(4, 4, [255, 255, 255, 255]), [{ kind: 'rect', region: { x: 0, y: 0, width: 1, height: 1 }, color: [0, 0, 255, 255], thickness: 2 }]);
      must(sameColor(getPixel(even, 0, 0), [0, 0, 255, 255]), 'thickness 2 covers (0,0)');
      must(sameColor(getPixel(even, 1, 0), [0, 0, 255, 255]), 'thickness 2 extra to +x');
      must(sameColor(getPixel(even, 0, 1), [0, 0, 255, 255]), 'thickness 2 extra to +y');
      must(sameColor(getPixel(even, 1, 1), [0, 0, 255, 255]), 'thickness 2 covers (1,1)');
      must(sameColor(getPixel(even, 2, 0), [255, 255, 255, 255]), 'thickness 2 does not reach (2,0)');
      const cross = vision.annotateImage(makeImage(11, 11, [255, 255, 255, 255]), [{ kind: 'cross', point: { x: 5, y: 5 }, size: 5, color: [255, 0, 0, 255], thickness: 1 }]);
      must(sameColor(getPixel(cross, 3, 5), [255, 0, 0, 255]), 'cross horizontal start');
      must(sameColor(getPixel(cross, 7, 5), [255, 0, 0, 255]), 'cross horizontal end');
      must(sameColor(getPixel(cross, 5, 3), [255, 0, 0, 255]), 'cross vertical start');
      must(sameColor(getPixel(cross, 5, 7), [255, 0, 0, 255]), 'cross vertical end');
      must(sameColor(getPixel(cross, 4, 4), [255, 255, 255, 255]), 'cross does not fill quadrants');
      return true;
    });

    await t('§9.C11', 'number 内置 3×5 位图（1/10/999）与边界裁剪', () => {
      const bitmap = {
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
      };
      const canvas = makeImage(40, 24, [255, 255, 255, 255]);
      const annotated = vision.annotateImage(canvas, [{ kind: 'number', point: { x: 2, y: 3 }, number: 101, color: [0, 0, 0, 255], thickness: 2 }]);
      const digits = '101';
      for (let digitIndex = 0; digitIndex < digits.length; digitIndex += 1) {
        const rows = bitmap[digits[digitIndex]];
        for (let row = 0; row < 5; row += 1) {
          for (let col = 0; col < 3; col += 1) {
            const on = rows[row][col] === '1';
            const baseX = 2 + digitIndex * 7 + col * 2;
            const baseY = 3 + row * 2;
            for (let dy = 0; dy < 2; dy += 1) {
              for (let dx = 0; dx < 2; dx += 1) {
                const pixel = getPixel(annotated, baseX + dx, baseY + dy);
                must(on ? sameColor(pixel, [0, 0, 0, 255]) : sameColor(pixel, [255, 255, 255, 255]), `digit bitmap ${digits[digitIndex]} ${row},${col}`);
              }
            }
          }
        }
      }
      must(sameColor(getPixel(annotated, 8, 3), [255, 255, 255, 255]), '1px gap between digits');
      const twoDigits = vision.annotateImage(makeImage(40, 24, [255, 255, 255, 255]), [{ kind: 'number', point: { x: 1, y: 1 }, number: 10, color: [0, 0, 0, 255], thickness: 2 }]);
      must(sameColor(getPixel(twoDigits, 7, 1), [255, 255, 255, 255]), '1px gap before second digit');
      must(sameColor(getPixel(twoDigits, 8, 1), [0, 0, 0, 255]), 'second digit starts at +7');
      must(sameColor(getPixel(twoDigits, 8, 2), [0, 0, 0, 255]), 'digit 0 row0 col0 on');
      const threeDigits = vision.annotateImage(makeImage(40, 24, [255, 255, 255, 255]), [{ kind: 'number', point: { x: 0, y: 0 }, number: 999, color: [0, 0, 0, 255], thickness: 2 }]);
      must(sameColor(getPixel(threeDigits, 19, 0), [0, 0, 0, 255]), '999 last column painted at x=19');
      must(sameColor(getPixel(threeDigits, 20, 0), [255, 255, 255, 255]), '999 width is 20px');
      const clipped = vision.annotateImage(makeImage(4, 4, [255, 255, 255, 255]), [{ kind: 'number', point: { x: 3, y: 3 }, number: 8, color: [0, 0, 0, 255], thickness: 2 }]);
      must(clipped.width === 4 && clipped.height === 4, 'number tail clipped, geometry unchanged');
      expectBrowserError(() => vision.annotateImage(makeImage(4, 4, [255, 255, 255, 255]), [{ kind: 'number', point: { x: 4, y: 0 }, number: 1 }]), 'INVALID_ARGUMENT');
      return true;
    });

    await t('§9.C11', 'arrow Bresenham 主线/箭翼 + 覆盖顺序 + source-over + 确定性', () => {
      const arrow = vision.annotateImage(makeImage(20, 10, [255, 255, 255, 255]), [{ kind: 'arrow', point: { x: 1, y: 5 }, to: { x: 15, y: 5 }, color: [255, 0, 0, 255], thickness: 1 }]);
      must(sameColor(getPixel(arrow, 1, 5), [255, 0, 0, 255]), 'arrow start');
      must(sameColor(getPixel(arrow, 15, 5), [255, 0, 0, 255]), 'arrow tip');
      must(sameColor(getPixel(arrow, 11, 1), [255, 0, 0, 255]), 'arrow wing upper endpoint (round(15-6/√2)=11, 5-4=1)');
      must(sameColor(getPixel(arrow, 11, 9), [255, 0, 0, 255]), 'arrow wing lower endpoint');
      must(sameColor(getPixel(arrow, 15, 1), [255, 255, 255, 255]), 'wings point backwards, not forward');
      // 覆盖顺序：后一个 annotation 覆盖前一个。
      const ordered = vision.annotateImage(makeImage(5, 5, [255, 255, 255, 255]), [
        { kind: 'rect', region: { x: 0, y: 0, width: 5, height: 5 }, color: [255, 0, 0, 255], thickness: 1 },
        { kind: 'cross', point: { x: 2, y: 2 }, size: 3, color: [0, 255, 0, 255], thickness: 1 },
      ]);
      must(sameColor(getPixel(ordered, 2, 2), [0, 255, 0, 255]), 'later annotation wins');
      must(sameColor(getPixel(ordered, 0, 2), [255, 0, 0, 255]), 'earlier annotation kept elsewhere');
      // source-over straight alpha。
      const over = vision.annotateImage(makeImage(3, 3, [255, 255, 255, 255]), [{ kind: 'rect', region: { x: 1, y: 1, width: 1, height: 1 }, color: [255, 0, 0, 128], thickness: 1 }]);
      must(sameColor(getPixel(over, 1, 1), [255, 127, 127, 255]), 'source-over alpha 128 over white');
      // 重复标注确定性。
      const first = vision.annotateImage(makeImage(20, 10, [255, 255, 255, 255]), [{ kind: 'arrow', point: { x: 1, y: 5 }, to: { x: 15, y: 5 }, color: [0, 0, 255, 255], thickness: 3 }]);
      const second = vision.annotateImage(makeImage(20, 10, [255, 255, 255, 255]), [{ kind: 'arrow', point: { x: 1, y: 5 }, to: { x: 15, y: 5 }, color: [0, 0, 255, 255], thickness: 3 }]);
      must(sameRgba(first, second), 'annotations deterministic');
      must(Buffer.compare(vision.encodePngRgba(first), vision.encodePngRgba(second)) === 0, 'annotation png hash deterministic');
      expectBrowserError(() => vision.annotateImage(makeImage(5, 5, [255, 255, 255, 255]), [{ kind: 'arrow', point: { x: 0, y: 0 }, to: { x: 5, y: 0 } }]), 'INVALID_ARGUMENT');
      return true;
    });

    /* ---------------- §9.C13 analysis ---------------- */
    await t('§9.C13', 'average/min/max/alpha/uniform/edgeRatio 全量', () => {
      const image = {
        width: 2,
        height: 2,
        rgba: Uint8Array.from([
          0, 10, 20, 0,
          100, 110, 120, 128,
          255, 0, 0, 255,
          1, 2, 3, 255,
        ]),
      };
      const analysis = vision.analyzeImage(image);
      must(analysis.pixelCount === 4, 'pixelCount');
      must(analysis.transparentPixels === 1 && analysis.opaquePixels === 2, 'alpha counts');
      const average = analysis.averageRgba;
      must(near(average[0], (0 + 100 + 255 + 1) / 4) && near(average[3], (0 + 128 + 255 + 255) / 4), 'average doubles');
      must(sameColor(analysis.minRgba, [0, 0, 0, 0]), 'min per channel');
      must(sameColor(analysis.maxRgba, [255, 110, 120, 255]), 'max per channel');
      must(analysis.uniform === false, 'uniform false');
      must(analysis.dominantColors.length === 4, 'four buckets');
      must(analysis.dominantColors.every((bucket) => bucket.count === 1 && near(bucket.fraction, 0.25)), 'bucket counts/fractions');
      // 4bit 量化桶 + 同 count 字典序。
      const ordered = makeImage(4, 5, [0, 0, 0, 255]);
      for (let index = 0; index < 8; index += 1) setPixel(ordered, index % 4, Math.floor(index / 4), [0, 0, 0, 255]);
      for (let index = 8; index < 16; index += 1) setPixel(ordered, index % 4, Math.floor(index / 4), [255, 255, 255, 255]);
      for (let index = 16; index < 20; index += 1) setPixel(ordered, index % 4, Math.floor(index / 4), [100, 100, 100, 255]);
      const orderedAnalysis = vision.analyzeImage(ordered);
      must(orderedAnalysis.dominantColors.length === 3, 'three buckets');
      must(sameColor(orderedAnalysis.dominantColors[0].rgba, [0, 0, 0, 240]), 'first bucket lexicographic among equal counts');
      must(sameColor(orderedAnalysis.dominantColors[1].rgba, [240, 240, 240, 240]), 'second bucket');
      must(sameColor(orderedAnalysis.dominantColors[2].rgba, [96, 96, 96, 240]), '100 quantizes to 96');
      must(near(orderedAnalysis.dominantColors[0].fraction, 0.4) && near(orderedAnalysis.dominantColors[2].fraction, 0.2), 'fractions');
      // 全透明图。
      const transparent = {
        width: 2,
        height: 2,
        rgba: Uint8Array.from([255, 0, 0, 0, 0, 255, 0, 0, 0, 0, 255, 0, 1, 2, 3, 0]),
      };
      const transparentAnalysis = vision.analyzeImage(transparent);
      must(transparentAnalysis.transparentPixels === 4 && transparentAnalysis.opaquePixels === 0, 'transparent counts');
      must(transparentAnalysis.uniform === false, 'transparent RGB differ');
      must(transparentAnalysis.edgePixels === 0, 'white-composited transparent has no edges');
      // 全量扫描（不抽样）：200×200 只有一个黑点。
      const sparse = makeImage(200, 200, [255, 255, 255, 255]);
      setPixel(sparse, 199, 199, [0, 0, 0, 255]);
      const sparseAnalysis = vision.analyzeImage(sparse);
      must(sameColor(sparseAnalysis.minRgba, [0, 0, 0, 255]), 'full scan sees single dark pixel');
      must(near(sparseAnalysis.averageRgba[0], (255 * 39999) / 40000), 'full-scan average');
      return true;
    });

    await t('§9.C13', 'uniform 与 edgePixels/edgeRatio（Sobel 阈值 32）', () => {
      const uniform = vision.analyzeImage(makeImage(3, 3, [12, 34, 56, 200]));
      must(uniform.uniform === true && uniform.dominantColors.length === 1, 'uniform image');
      must(near(uniform.dominantColors[0].fraction, 1), 'uniform fraction 1');
      const step = makeImage(5, 5, [255, 255, 255, 255]);
      for (let y = 0; y < 5; y += 1) {
        for (let x = 0; x < 2; x += 1) setPixel(step, x, y, [0, 0, 0, 255]);
      }
      const stepAnalysis = vision.analyzeImage(step);
      // 黑白阶跃的 Sobel 响应落在 x=1 与 x=2 两列（y=1..3），边界一圈不计。
      must(stepAnalysis.edgePixels === 6, 'step edge pixels (border excluded)');
      must(near(stepAnalysis.edgeRatio, 6 / 25), 'edgeRatio denominator includes border ring');
      return true;
    });

    /* ---------------- §9.C15 连通域 ---------------- */
    await t('§9.C15', '8 邻接/area/centroid/score', () => {
      const diagonal = makeImage(5, 5, [255, 255, 255, 255]);
      setPixel(diagonal, 1, 1, [255, 0, 0, 255]);
      setPixel(diagonal, 2, 2, [255, 0, 0, 255]);
      const result = vision.findInImage(diagonal, { method: 'color', color: [255, 0, 0], tolerance: 0, minArea: 1 });
      must(result.candidates.length === 1, 'diagonal pixels are 8-connected');
      must(result.candidates[0].area === 2, 'area 2');
      must(sameColor([result.candidates[0].region.x, result.candidates[0].region.y, result.candidates[0].region.width, result.candidates[0].region.height], [1, 1, 2, 2]), 'bbox');
      must(near(result.candidates[0].centroid.x, 2) && near(result.candidates[0].centroid.y, 2), 'centroid uses pixel centers');
      must(near(result.candidates[0].score, 0.5), 'score = area/bbox');
      must(result.candidates[0].semanticName === null, 'semanticName null');
      // 环形连通域。
      const ring = makeImage(5, 5, [255, 255, 255, 255]);
      for (let x = 0; x < 5; x += 1) {
        setPixel(ring, x, 0, [255, 0, 0, 255]);
        setPixel(ring, x, 4, [255, 0, 0, 255]);
      }
      for (let y = 0; y < 5; y += 1) {
        setPixel(ring, 0, y, [255, 0, 0, 255]);
        setPixel(ring, 4, y, [255, 0, 0, 255]);
      }
      const ringResult = vision.findInImage(ring, { method: 'color', color: [255, 0, 0], tolerance: 0, minArea: 1 });
      must(ringResult.candidates.length === 1 && ringResult.candidates[0].area === 16, 'ring component area 16');
      must(near(ringResult.candidates[0].score, 16 / 25), 'ring score');
      return true;
    });

    await t('§9.C15', 'minArea/排序/maxResults/truncated/ROI 回加', () => {
      const image = makeImage(20, 20, [255, 255, 255, 255]);
      // 面积 1 噪点 + 面积 3 组件。
      setPixel(image, 1, 1, [255, 0, 0, 255]);
      setPixel(image, 10, 10, [255, 0, 0, 255]);
      setPixel(image, 11, 10, [255, 0, 0, 255]);
      setPixel(image, 10, 11, [255, 0, 0, 255]);
      const filtered = vision.findInImage(image, { method: 'color', color: [255, 0, 0], tolerance: 0, minArea: 2 });
      must(filtered.candidates.length === 1 && filtered.candidates[0].area === 3, 'minArea filters noise');
      must(filtered.totalCandidates === 1 && filtered.truncated === false, 'filtered totals');
      // 同 area 异 y/x 排序。
      const sorting = makeImage(20, 20, [255, 255, 255, 255]);
      const pairs = [[1, 1], [1, 5], [5, 5]];
      for (const [x, y] of pairs) {
        setPixel(sorting, x, y, [255, 0, 0, 255]);
        setPixel(sorting, x + 1, y, [255, 0, 0, 255]);
      }
      const sorted = vision.findInImage(sorting, { method: 'color', color: [255, 0, 0], tolerance: 0, minArea: 1, maxResults: 10 });
      must(sorted.candidates.length === 3, 'three components');
      must(sorted.candidates[0].region.y === 1 && sorted.candidates[0].region.x === 1, 'area tie -> y asc, x asc (first)');
      must(sorted.candidates[1].region.y === 5 && sorted.candidates[1].region.x === 1, 'area tie -> y asc (second)');
      must(sorted.candidates[2].region.y === 5 && sorted.candidates[2].region.x === 5, 'area tie -> x asc (third)');
      // maxResults 截断。
      const many = makeImage(30, 30, [255, 255, 255, 255]);
      for (let index = 0; index < 5; index += 1) setPixel(many, index * 5 + 1, 1, [255, 0, 0, 255]);
      const truncated = vision.findInImage(many, { method: 'color', color: [255, 0, 0], tolerance: 0, minArea: 1, maxResults: 2 });
      must(truncated.candidates.length === 2 && truncated.totalCandidates === 5 && truncated.truncated === true, 'maxResults truncation');
      must(truncated.candidates[0].id === 'c1' && truncated.candidates[1].id === 'c2', 'candidate ids');
      // ROI 回加完整图坐标。
      const roiImage = makeImage(10, 10, [255, 255, 255, 255]);
      setPixel(roiImage, 3, 3, [255, 0, 0, 255]);
      const roiResult = vision.findInImage(roiImage, { method: 'color', color: [255, 0, 0], tolerance: 0, minArea: 1 }, { roi: { x: 2, y: 2, width: 5, height: 5 } });
      must(roiResult.candidates.length === 1, 'roi candidate');
      must(roiResult.candidates[0].region.x === 3 && roiResult.candidates[0].region.y === 3, 'roi offset added to region');
      must(near(roiResult.candidates[0].centroid.x, 3.5), 'roi offset added to centroid');
      // components 方法：白底 + 蓝块。
      const componentsImage = makeImage(10, 10, [255, 255, 255, 255]);
      for (let y = 2; y < 4; y += 1) for (let x = 2; x < 4; x += 1) setPixel(componentsImage, x, y, [0, 0, 255, 255]);
      const components = vision.findInImage(componentsImage, { method: 'components', background: [255, 255, 255], tolerance: 16, minArea: 1 });
      must(components.candidates.length === 1 && components.candidates[0].area === 4, 'components method');
      must(components.candidates[0].signal === 'component', 'components signal');
      return true;
    });

    /* ---------------- §9.C16 Sobel/模板/NMS/预算 ---------------- */
    await t('§9.C16', 'Sobel 边界/阈值公式', () => {
      const step = makeImage(5, 5, [255, 255, 255, 255]);
      for (let y = 0; y < 5; y += 1) for (let x = 0; x < 2; x += 1) setPixel(step, x, y, [0, 0, 0, 255]);
      const edges = vision.edgeMask(step, 32);
      // Sobel 在阶跃两侧 x=1、x=2 都产生 m=round(4*255/8)=128 的响应。
      must(edges[1 * 5 + 1] === 1 && edges[1 * 5 + 2] === 1, 'step edge columns x=1,x=2 at y=1');
      must(edges[2 * 5 + 1] === 1 && edges[2 * 5 + 2] === 1, 'step edge columns x=1,x=2 at y=2');
      must(edges[3 * 5 + 1] === 1 && edges[3 * 5 + 2] === 1, 'step edge columns x=1,x=2 at y=3');
      must(edges[2 * 5 + 0] === 0 && edges[2 * 5 + 3] === 0 && edges[2 * 5 + 4] === 0, 'no edge on flat columns');
      must(edges[0] === 0 && edges[4 * 5 + 4] === 0, 'border ring excluded');
      const high = vision.edgeMask(step, 129);
      must(high.every((value) => value === 0), 'threshold 129 excludes m=128');
      const at = vision.edgeMask(step, 128);
      must(at[2 * 5 + 1] === 1 && at[2 * 5 + 2] === 1, 'threshold 128 includes m=128');
      const found = vision.findInImage(step, { method: 'edges', edgeThreshold: 32, minArea: 1 });
      must(found.candidates.length === 1 && found.candidates[0].area === 6, 'edges method components');
      return true;
    });

    await t('§9.C16', 'template 评分/stride/坐标与参考实现一致', () => {
      const templatePattern = [
        [255, 0, 0, 255], [0, 255, 0, 255], [0, 0, 255, 255],
        [0, 255, 0, 255], [255, 255, 255, 255], [0, 255, 0, 255],
        [0, 0, 255, 255], [0, 255, 0, 255], [255, 0, 0, 255],
      ];
      const template = makeImage(3, 3);
      for (let y = 0; y < 3; y += 1) for (let x = 0; x < 3; x += 1) setPixel(template, x, y, templatePattern[y * 3 + x]);
      const image = makeImage(12, 12, [0, 0, 0, 255]);
      const paste = (originX, originY) => {
        for (let y = 0; y < 3; y += 1) for (let x = 0; x < 3; x += 1) setPixel(image, originX + x, originY + y, templatePattern[y * 3 + x]);
      };
      paste(1, 1);
      paste(7, 5);
      const query = { method: 'template', template: { kind: 'product', productId: 'v1_' + 'a'.repeat(32) }, minScore: 1, stride: 1, maxResults: 20 };
      const result = vision.findInImage(image, query, { templateImage: template });
      must(result.candidates.length === 2, 'two exact template matches');
      must(result.candidates[0].region.x === 1 && result.candidates[0].region.y === 1, 'first match sorted by y');
      must(result.candidates[1].region.x === 7 && result.candidates[1].region.y === 5, 'second match');
      must(near(result.candidates[0].score, 1) && near(result.candidates[1].score, 1), 'exact scores');
      must(near(result.candidates[0].centroid.x, 2.5) && near(result.candidates[0].centroid.y, 2.5), 'template centroid');
      must(result.candidates[0].area === 9 && result.candidates[0].signal === 'template', 'template area/signal');
      must(result.metrics.evaluatedPositions === 100 && result.metrics.pixelComparisons === 900, 'template metrics');
      // stride：末尾不补点。
      const strideResult = vision.findInImage(image, { ...query, stride: 2 }, { templateImage: template });
      must(strideResult.metrics.evaluatedPositions === 25, 'stride 2 positions = 5*5');
      // 模板大于 ROI 拒绝。
      expectBrowserError(() => vision.findInImage(image, query, { templateImage: template, roi: { x: 0, y: 0, width: 2, height: 2 } }), 'INVALID_ARGUMENT');
      return true;
    });

    await t('§9.C16', 'NMS IoU>0.3 贪心（0.3 保留 / >0.3 抑制）', () => {
      // 1×13 模板，周期 7 的列图案在 y=0 与 y=7 精确匹配 -> IoU=6/20=0.3（保留）。
      const period7 = [0, 30, 60, 90, 120, 150, 180, 0, 30, 60, 90, 120, 150];
      const template = makeImage(1, 13);
      for (let y = 0; y < 13; y += 1) setPixel(template, 0, y, [period7[y], period7[y], period7[y], 255]);
      const image = makeImage(1, 20);
      for (let y = 0; y < 20; y += 1) {
        const value = y < 13 ? period7[y] : period7[y - 7];
        setPixel(image, 0, y, [value, value, value, 255]);
      }
      const query = { method: 'template', template: { kind: 'product', productId: 'v1_' + 'b'.repeat(32) }, minScore: 1, stride: 1, maxResults: 20 };
      const kept = vision.findInImage(image, query, { templateImage: template });
      must(kept.candidates.length === 2, 'IoU exactly 0.3 kept');
      must(kept.candidates[0].region.y === 0 && kept.candidates[1].region.y === 7, 'exact-0.3 matches');
      // 周期 6 -> IoU=7/19>0.3，后者被抑制。
      const period6 = [0, 30, 60, 90, 120, 150, 0, 30, 60, 90, 120, 150, 0];
      const template6 = makeImage(1, 13);
      for (let y = 0; y < 13; y += 1) setPixel(template6, 0, y, [period6[y], period6[y], period6[y], 255]);
      const image6 = makeImage(1, 19);
      for (let y = 0; y < 19; y += 1) {
        const value = y < 13 ? period6[y] : period6[y - 6];
        setPixel(image6, 0, y, [value, value, value, 255]);
      }
      const suppressed = vision.findInImage(image6, query, { templateImage: template6 });
      must(suppressed.candidates.length === 1, 'IoU > 0.3 suppressed');
      must(suppressed.candidates[0].region.y === 0, 'greedy keeps highest (tie -> lower y)');
      must(suppressed.totalCandidates === 1, 'totalCandidates after NMS');
      return true;
    });

    await t('§9.C16', '模板候选 50M 比较预检（零扫描）', () => {
      const image = makeImage(1000, 1000, [0, 0, 0, 255]);
      const template = makeImage(100, 100, [255, 255, 255, 255]);
      const started = Date.now();
      const error = expectBrowserError(
        () => vision.findInImage(image, { method: 'template', template: { kind: 'product', productId: 'v1_' + 'c'.repeat(32) } }, { templateImage: template }),
        'VISION_LIMIT_EXCEEDED',
      );
      const elapsed = Date.now() - started;
      must(error.details.limit === 'maxTemplateComparisons', 'comparison limit name');
      must(error.details.max === 50000000 && error.details.actual > 50000000, 'comparison limit details');
      must(elapsed < 1000, 'precheck happens before scanning');
      return true;
    });

    /* ---------------- §9.C18 YIQ 黄金数值 ---------------- */
    await t('§9.C18', '白/黑、透明、alpha128 黄金数值与严格阈值', () => {
      const white = makeImage(1, 1, [255, 255, 255, 255]);
      const black = makeImage(1, 1, [0, 0, 0, 255]);
      const whiteBlack = vision.diffImages(white, black, {});
      must(whiteBlack.metrics.diffPixels === 1 && near(whiteBlack.metrics.diffRatio, 1) && near(whiteBlack.metrics.similarity, 0), 'white/black diff');
      must(near(refDelta(white.rgba, black.rgba, 0), 32857.13315714265, 1e-9), 'golden delta white/black');
      // 透明红 vs 透明蓝：白底合成后完全一致。
      const transparentRed = makeImage(1, 1, [255, 0, 0, 0]);
      const transparentBlue = makeImage(1, 1, [0, 0, 255, 0]);
      must(near(refDelta(transparentRed.rgba, transparentBlue.rgba, 0), 0), 'transparent RGB difference vanishes');
      must(vision.diffImages(transparentRed, transparentBlue, { options: { threshold: 0 } }).metrics.diffPixels === 0, 'threshold 0 strict: delta=0 not a diff');
      // alpha 128 红 vs 蓝：黄金 delta。
      const halfRed = makeImage(1, 1, [255, 0, 0, 128]);
      const halfBlue = makeImage(1, 1, [0, 0, 255, 128]);
      must(near(refDelta(halfRed.rgba, halfBlue.rgba, 0), 4439.774939855673, 1e-9), 'golden delta alpha128 red/blue');
      must(vision.diffImages(halfRed, halfBlue, {}).metrics.diffPixels === 1, 'alpha128 diff at default threshold');
      // 阈值边界：delta = 32857.13315714265，threshold0 = sqrt(delta/35215)。
      const boundary = Math.sqrt(32857.13315714265 / 35215);
      must(vision.diffImages(white, black, { options: { threshold: boundary * 0.999 } }).metrics.diffPixels === 1, 'just below boundary -> diff');
      must(vision.diffImages(white, black, { options: { threshold: boundary * 1.001 } }).metrics.diffPixels === 0, 'just above boundary -> no diff');
      // threshold 1：红 vs 青 delta=35214.74895545784 < 35215，不判差。
      const red = makeImage(1, 1, [255, 0, 0, 255]);
      const cyan = makeImage(1, 1, [0, 255, 255, 255]);
      must(near(refDelta(red.rgba, cyan.rgba, 0), 35214.74895545784, 1e-9), 'golden delta red/cyan');
      must(vision.diffImages(red, cyan, { options: { threshold: 1 } }).metrics.diffPixels === 0, 'threshold 1 formula');
      // threshold 0：1 LSB 灰度差敏感。
      const almostWhite = makeImage(1, 1, [254, 254, 254, 255]);
      must(vision.diffImages(white, almostWhite, { options: { threshold: 0 } }).metrics.diffPixels === 1, 'threshold 0 catches 1 LSB');
      return true;
    });

    /* ---------------- §9.C19 AA ---------------- */
    const rampBefore = makeImage(5, 5, [100, 100, 100, 255]);
    const rampAfter = makeImage(5, 5, [100, 100, 100, 255]);
    for (let y = 0; y < 5; y += 1) {
      for (const [x, value] of [[2, 128], [3, 160], [4, 160]]) {
        setPixel(rampBefore, x, y, [value, value, value, 255]);
        setPixel(rampAfter, x, y, [value, value, value, 255]);
      }
    }
    setPixel(rampAfter, 2, 2, [0, 0, 0, 255]);

    await t('§9.C19', 'AA 3×3 排除与 includeAA=true 翻转', () => {
      const defaultResult = vision.diffImages(rampBefore, rampAfter, {});
      must(defaultResult.metrics.diffPixels === 0 && defaultResult.metrics.aaPixels === 1, 'ramp center excluded as AA');
      const includeResult = vision.diffImages(rampBefore, rampAfter, { options: { includeAA: true } });
      must(includeResult.metrics.diffPixels === 1 && includeResult.metrics.aaPixels === 0, 'includeAA flips');
      const reference = refDiffCounts(rampBefore, rampAfter, {});
      must(reference.diffPixels === 0 && reference.aaPixels === 1, 'reference agrees (before image AA)');
      // 两图任一图符合即排除：交换 before/after 仍排除。
      const swapped = vision.diffImages(rampAfter, rampBefore, {});
      must(swapped.metrics.diffPixels === 0 && swapped.metrics.aaPixels === 1, 'AA applies from either image');
      return true;
    });

    await t('§9.C19', '相等邻居>2 非 AA / 边界 equal 初值 / tie 顺序', () => {
      // 相等邻居 3 个 -> 非 AA。
      const equalBefore = makeImage(5, 5, [100, 100, 100, 255]);
      setPixel(equalBefore, 2, 1, [128, 128, 128, 255]);
      setPixel(equalBefore, 2, 3, [128, 128, 128, 255]);
      setPixel(equalBefore, 1, 2, [128, 128, 128, 255]);
      setPixel(equalBefore, 2, 2, [128, 128, 128, 255]);
      setPixel(equalBefore, 3, 2, [160, 160, 160, 255]);
      const equalAfter = cloneImage(equalBefore);
      setPixel(equalAfter, 2, 2, [0, 0, 0, 255]);
      const equalResult = vision.diffImages(equalBefore, equalAfter, {});
      must(equalResult.metrics.diffPixels === 1 && equalResult.metrics.aaPixels === 0, 'equal neighbors > 2 -> not AA');
      must(refDiffCounts(equalBefore, equalAfter, {}).diffPixels === 1, 'reference agrees on equal neighbors');

      // 边界 equal 初值 1：边中点 (0,2) 恰有 2 个相等邻居，若不设初值会被误判 AA。
      const borderBefore = makeImage(5, 5, [100, 100, 100, 255]);
      setPixel(borderBefore, 0, 1, [128, 128, 128, 255]);
      setPixel(borderBefore, 1, 2, [128, 128, 128, 255]);
      setPixel(borderBefore, 0, 2, [128, 128, 128, 255]);
      setPixel(borderBefore, 0, 3, [100, 100, 100, 255]);
      setPixel(borderBefore, 1, 1, [100, 100, 100, 255]);
      setPixel(borderBefore, 1, 3, [160, 160, 160, 255]);
      setPixel(borderBefore, 0, 0, [100, 100, 100, 255]);
      setPixel(borderBefore, 1, 0, [100, 100, 100, 255]);
      setPixel(borderBefore, 2, 0, [100, 100, 100, 255]);
      setPixel(borderBefore, 2, 1, [100, 100, 100, 255]);
      setPixel(borderBefore, 2, 2, [100, 100, 100, 255]);
      setPixel(borderBefore, 2, 3, [100, 100, 100, 255]);
      setPixel(borderBefore, 0, 4, [100, 100, 100, 255]);
      setPixel(borderBefore, 1, 4, [100, 100, 100, 255]);
      setPixel(borderBefore, 2, 4, [100, 100, 100, 255]);
      const borderAfter = cloneImage(borderBefore);
      setPixel(borderAfter, 0, 2, [0, 0, 0, 255]);
      const borderResult = vision.diffImages(borderBefore, borderAfter, {});
      must(borderResult.metrics.diffPixels === 1 && borderResult.metrics.aaPixels === 0, 'border equal count starts at 1 -> not AA');
      const borderReference = refDiffCounts(borderBefore, borderAfter, {});
      must(borderReference.diffPixels === 1 && borderReference.aaPixels === 0, 'reference agrees on border init');

      // tie 顺序：两个并列最暗邻居，(2,1) 满足条件、(1,2) 不满足；按 y 后 x 升序取 (2,1) -> AA。
      const tieBefore = makeImage(5, 5, [100, 100, 100, 255]);
      setPixel(tieBefore, 0, 1, [160, 160, 160, 255]);
      setPixel(tieBefore, 0, 2, [160, 160, 160, 255]);
      setPixel(tieBefore, 0, 3, [160, 160, 160, 255]);
      setPixel(tieBefore, 1, 1, [160, 160, 160, 255]);
      setPixel(tieBefore, 2, 1, [100, 100, 100, 255]);
      setPixel(tieBefore, 3, 1, [160, 160, 160, 255]);
      setPixel(tieBefore, 1, 2, [100, 100, 100, 255]);
      setPixel(tieBefore, 2, 2, [128, 128, 128, 255]);
      setPixel(tieBefore, 3, 2, [160, 160, 160, 255]);
      setPixel(tieBefore, 1, 3, [160, 160, 160, 255]);
      setPixel(tieBefore, 2, 3, [160, 160, 160, 255]);
      setPixel(tieBefore, 3, 3, [100, 100, 100, 255]);
      const tieAfter = cloneImage(tieBefore);
      setPixel(tieAfter, 2, 2, [0, 0, 0, 255]);
      const tieResult = vision.diffImages(tieBefore, tieAfter, {});
      const tieReference = refDiffCounts(tieBefore, tieAfter, {});
      must(tieResult.metrics.diffPixels === tieReference.diffPixels, 'tie order D matches reference');
      must(tieResult.metrics.aaPixels === tieReference.aaPixels, 'tie order A matches reference');
      must(tieResult.metrics.diffPixels === 0 && tieResult.metrics.aaPixels === 1, 'tie picks darkest with y then x order -> AA');
      return true;
    });

    /* ---------------- §9.C20 分母/mask/EMPTY ---------------- */
    await t('§9.C20', 'diffRatio/similarity/mask 并集/AA 仍在分母', () => {
      const before = makeImage(100, 100, [128, 128, 128, 255]);
      const after = cloneImage(before);
      for (let y = 0; y < 10; y += 1) for (let x = 0; x < 10; x += 1) setPixel(after, x, y, [0, 0, 0, 255]);
      const result = vision.diffImages(before, after, {});
      must(result.metrics.diffPixels === 100 && result.metrics.comparedPixels === 10000, '100 changed pixels');
      must(near(result.metrics.diffRatio, 0.01) && near(result.metrics.similarity, 0.99), 'ratio/similarity');
      // mask 并集不重计。
      const masked = vision.diffImages(before, after, {
        masks: [
          { id: 'a', region: { x: 0, y: 0, width: 10, height: 10 } },
          { id: 'b', region: { x: 5, y: 5, width: 10, height: 10 } },
        ],
      });
      must(masked.metrics.maskedPixels === 175, 'mask union counted once');
      must(masked.metrics.comparedPixels === 10000 - 175, 'denominator C = N - M');
      must(near(masked.metrics.diffRatio, 0 / (10000 - 175)), 'masked diff pixels excluded from D');
      // AA 仍在分母：ramp 场景 C=N。
      const aaResult = vision.diffImages(rampBefore, rampAfter, {});
      must(aaResult.metrics.comparedPixels === 25 && aaResult.metrics.aaPixels === 1, 'AA still in denominator');
      must(near(aaResult.metrics.similarity, 1), 'similarity 1 with AA excluded but D=0');
      // 0/1 相似度。
      const allDiff = vision.diffImages(makeImage(2, 2, [0, 0, 0, 255]), makeImage(2, 2, [255, 255, 255, 255]), {});
      must(near(allDiff.metrics.similarity, 0), 'similarity 0');
      const same = vision.diffImages(rampBefore, rampBefore, {});
      must(near(same.metrics.similarity, 1) && same.metrics.diffPixels === 0, 'similarity 1 for identical');
      // mask 像素中心规则 + 部分落在 ROI 外。
      const onePixel = vision.diffImages(before, after, { masks: [{ id: 'p', region: { x: 0, y: 0, width: 1, height: 1 } }] });
      must(onePixel.metrics.maskedPixels === 1, '1x1 mask masks exactly one pixel');
      const partial = vision.diffImages(before, after, {
        region: { x: 0, y: 0, width: 96, height: 96 },
        masks: [{ id: 'q', region: { x: 95, y: 95, width: 5, height: 5 } }],
      });
      must(partial.metrics.maskedPixels === 1, 'mask intersection with ROI only');
      // 全 mask -> EMPTY。
      expectBrowserError(
        () => vision.diffImages(before, after, { masks: [{ id: 'all', region: { x: 0, y: 0, width: 100, height: 100 } }] }),
        'VISION_EMPTY_COMPARISON',
      );
      // 尺寸不等。
      const mismatch = expectBrowserError(
        () => vision.diffImages(before, makeImage(99, 100), {}),
        'VISION_SIZE_MISMATCH',
      );
      must(mismatch.details.before.width === 100 && mismatch.details.after.width === 99, 'size mismatch details');
      return true;
    });

    /* ---------------- §9.C21 阈值 ---------------- */
    await t('§9.C21', 'warn/fail 等号、默认值与错误顺序', () => {
      must(vision.ratioVerdict(0) === 'PASS', 'ratio 0 PASS');
      must(vision.ratioVerdict(0.001) === 'PASS', 'equal warn -> lower level PASS');
      must(vision.ratioVerdict(0.0010000001) === 'WARN', 'just above warn -> WARN');
      must(vision.ratioVerdict(0.01) === 'WARN', 'equal fail -> lower level WARN');
      must(vision.ratioVerdict(0.0100000001) === 'FAIL', 'just above fail -> FAIL');
      must(vision.ratioVerdict(1) === 'FAIL', 'ratio 1 FAIL');
      // D=10/10000 PASS、11 WARN、100 WARN、101 FAIL（不四舍五入）。
      const build = (count) => {
        const before = makeImage(100, 100, [128, 128, 128, 255]);
        const after = cloneImage(before);
        for (let index = 0; index < count; index += 1) {
          const x = index % 100;
          const y = Math.floor(index / 100);
          setPixel(after, x, y, [0, 0, 0, 255]);
        }
        return vision.diffImages(before, after, {}).metrics.diffRatio;
      };
      must(vision.ratioVerdict(build(10)) === 'PASS', 'D=10 PASS');
      must(vision.ratioVerdict(build(11)) === 'WARN', 'D=11 WARN');
      must(vision.ratioVerdict(build(100)) === 'WARN', 'D=100 WARN');
      must(vision.ratioVerdict(build(101)) === 'FAIL', 'D=101 FAIL');
      expectBrowserError(() => vision.validateThresholds({ warnRatio: 0.5, failRatio: 0.4 }), 'INVALID_ARGUMENT');
      must(vision.validateThresholds({ warnRatio: 0.5, failRatio: 0.5 }).warnRatio === 0.5, 'equal warn/fail allowed');
      return true;
    });

    /* ---------------- §9.C23 差异区域 ---------------- */
    await t('§9.C23', '8 邻接区域/area 排序/过滤不改 D/100 截断', () => {
      const before = makeImage(10, 10, [128, 128, 128, 255]);
      const after = cloneImage(before);
      setPixel(after, 1, 1, [0, 0, 0, 255]);
      setPixel(after, 2, 2, [0, 0, 0, 255]);
      const diagonal = vision.diffImages(before, after, {});
      must(diagonal.regions.length === 1 && diagonal.regions[0].area === 2, 'diagonal diff one region');
      must(sameColor([diagonal.regions[0].imagePixels.x, diagonal.regions[0].imagePixels.y, diagonal.regions[0].imagePixels.width, diagonal.regions[0].imagePixels.height], [1, 1, 2, 2]), 'region bbox');
      // 过滤不改 D。
      const filteredBefore = makeImage(20, 20, [128, 128, 128, 255]);
      const filteredAfter = cloneImage(filteredBefore);
      for (let y = 5; y < 7; y += 1) for (let x = 5; x < 7; x += 1) setPixel(filteredAfter, x, y, [0, 0, 0, 255]);
      setPixel(filteredAfter, 15, 15, [0, 0, 0, 255]);
      const unfiltered = vision.diffImages(filteredBefore, filteredAfter, {});
      const filtered = vision.diffImages(filteredBefore, filteredAfter, { options: { minRegionPixels: 2 } });
      must(unfiltered.metrics.diffPixels === 5 && filtered.metrics.diffPixels === 5, 'minRegionPixels does not change D');
      must(unfiltered.regionCount === 2 && filtered.regionCount === 1, 'minRegionPixels filters output regions');
      // 101 色块面积 + area 排序。
      const blockBefore = makeImage(40, 40, [128, 128, 128, 255]);
      const blockAfter = cloneImage(blockBefore);
      for (let y = 2; y < 12; y += 1) {
        for (let x = 2; x < 12; x += 1) setPixel(blockAfter, x, y, [0, 0, 0, 255]);
      }
      setPixel(blockAfter, 12, 12, [0, 0, 0, 255]); // 8 邻接并入 -> 101
      for (let index = 0; index < 5; index += 1) setPixel(blockAfter, 10 + index * 4, 30, [0, 0, 0, 255]);
      const block = vision.diffImages(blockBefore, blockAfter, {});
      must(block.regions[0].area === 101, 'largest region area 101');
      must(block.regions[0].imagePixels.x === 2 && block.regions[0].imagePixels.width === 11, 'block bbox width 11');
      must(block.regionCount === 6, 'six regions after filter');
      // 100 截断：120 个孤立差异像素。
      const manyBefore = makeImage(40, 40, [128, 128, 128, 255]);
      const manyAfter = cloneImage(manyBefore);
      for (let row = 0; row < 10; row += 1) {
        for (let column = 0; column < 12; column += 1) {
          setPixel(manyAfter, 1 + column * 3, 1 + row * 3, [0, 0, 0, 255]);
        }
      }
      const many = vision.diffImages(manyBefore, manyAfter, {});
      must(many.metrics.diffPixels === 120, '120 isolated diff pixels');
      must(many.regions.length === 100 && many.regionCount === 120 && many.regionsTruncated === true, '100 region truncation');
      return true;
    });

    await t('§9.C23', '高亮黄金像素（灰/红/黄/灰128/蓝 bbox）与完整尺寸', () => {
      const before = makeImage(8, 8, [200, 200, 200, 255]);
      const after = cloneImage(before);
      for (let y = 1; y < 4; y += 1) for (let x = 1; x < 4; x += 1) setPixel(after, x, y, [0, 0, 0, 255]);
      const result = vision.diffImages(before, after, { masks: [{ id: 'clock', region: { x: 5, y: 1, width: 2, height: 1 } }] });
      const decoded = vision.decodePngToRgba(result.highlight);
      must(decoded.ok === true && decoded.width === 8 && decoded.height === 8, 'highlight is full-size PNG');
      must(sameColor(getPixel(decoded, 7, 7), [250, 250, 250, 255]), 'same pixel uses before white-composited gray');
      must(sameColor(getPixel(decoded, 2, 2), [255, 0, 0, 255]), 'diff center red (inside bbox)');
      must(sameColor(getPixel(decoded, 1, 1), [0, 128, 255, 255]), 'bbox border blue');
      must(sameColor(getPixel(decoded, 5, 1), [128, 128, 128, 255]), 'mask pixel gray 128');
      // ROI 外的差异不参与统计，仍画 before 灰度。
      const outsideBefore = makeImage(6, 6, [100, 100, 100, 255]);
      const outsideAfter = cloneImage(outsideBefore);
      setPixel(outsideAfter, 0, 0, [0, 0, 0, 255]);
      const outside = vision.diffImages(outsideBefore, outsideAfter, { region: { x: 2, y: 2, width: 2, height: 2 } });
      must(outside.metrics.totalPixels === 4 && outside.metrics.diffPixels === 0, 'ROI excludes outside diff');
      const outsideDecoded = vision.decodePngToRgba(outside.highlight);
      must(sameColor(getPixel(outsideDecoded, 0, 0), [240, 240, 240, 255]), 'outside ROI drawn as before gray');
      must(sameColor(getPixel(outsideDecoded, 2, 2), [240, 240, 240, 255]), 'same pixel inside ROI drawn gray');
      return true;
    });

    /* ---------------- §9.C29 派生/年龄可纯测部分 ---------------- */
    await t('§9.C29', 'store 保留 actionable/capturedAt 与派生 mapping 不刷新年龄语义', () => {
      const store = new vision.VisionProductStore({ now: () => 5000 });
      const capture = store.add({
        bytes: Buffer.from([1, 2, 3]),
        width: 10,
        height: 10,
        kind: 'capture',
        actionable: true,
        capturedAt: 1000,
        mapping: makeMapping(),
      });
      const derived = store.add({
        bytes: Buffer.from([4, 5, 6]),
        width: 10,
        height: 10,
        kind: 'derived',
        actionable: false,
        capturedAt: capture.capturedAt,
        parentIds: [capture.productId],
        mapping: vision.mappingAfterCrop(makeMapping(), { x: 2, y: 4, width: 5, height: 5 }),
      });
      must(capture.actionable === true && derived.actionable === false, 'actionable preserved (derived not actionable)');
      must(derived.capturedAt === 1000 && derived.createdAt === 5000, 'capturedAt keeps ancestor age, createdAt is new');
      const fetched = store.get(derived.productId);
      must(fetched.actionable === false && fetched.capturedAt === 1000, 'get returns stored actionable/capturedAt');
      must(near(fetched.mapping.originCss.x, 11) && near(fetched.mapping.originCss.y, 22), 'derived mapping origin');
      must(fetched.parentIds.length === 1 && fetched.parentIds[0] === capture.productId, 'lineage parentIds');
      // 基线/差异类 product 不可操作（Host 传入 actionable=false）。
      const baseline = store.add({ bytes: Buffer.from([7]), width: 1, height: 1, kind: 'baseline', actionable: false, mapping: makeMapping() });
      must(baseline.actionable === false, 'baseline product not actionable');
      return true;
    });

    /* ---------------- §9.C52 预算/取消 ---------------- */
    await t('§9.C52', '同步/异步预算超时抛 VISION_TIMEOUT', async () => {
      const image = makeImage(50, 50, [0, 0, 0, 255]);
      const syncError = expectBrowserError(
        () => vision.diffImages(image, image, { startedAt: Date.now() - 10000, budgetMs: 5000 }),
        'VISION_TIMEOUT',
      );
      must(syncError.details.budgetMs === 5000 && syncError.retryable === true, 'timeout details');
      await expectBrowserErrorAsync(
        () => vision.diffImagesAsync(image, image, { startedAt: Date.now() - 10000, budgetMs: 5000 }),
        'VISION_TIMEOUT',
      );
      await expectBrowserErrorAsync(
        () => vision.analyzeImageAsync(image, { startedAt: Date.now() - 10000, budgetMs: 5000 }),
        'VISION_TIMEOUT',
      );
      return true;
    });

    await t('§9.C52', '取消：预取消 signal 与运行中 abort 都不半交付', async () => {
      const image = makeImage(100, 100, [0, 0, 0, 255]);
      const preAborted = new AbortController();
      preAborted.abort();
      await expectBrowserErrorAsync(() => vision.diffImagesAsync(image, image, { signal: preAborted.signal }), 'ABORTED');
      const controller = new AbortController();
      const big = makeImage(1000, 1000, [0, 0, 0, 255]);
      let eventLoopRan = false;
      setImmediate(() => {
        eventLoopRan = true;
        controller.abort();
      });
      let rejected = null;
      try {
        await vision.diffImagesAsync(big, big, { signal: controller.signal });
      } catch (error) {
        rejected = error;
      }
      must(rejected instanceof BrowserError && rejected.code === 'ABORTED', 'mid-run abort -> ABORTED');
      must(eventLoopRan === true, 'async loop yielded to the event loop before finishing');
      return true;
    });

    await t('§9.C52', '异步算法让出事件循环且结果与同步一致', async () => {
      const before = makeImage(1000, 1000, [128, 128, 128, 255]);
      const after = cloneImage(before);
      for (let y = 0; y < 5; y += 1) for (let x = 0; x < 5; x += 1) setPixel(after, x, y, [0, 0, 0, 255]);
      let yielded = false;
      setImmediate(() => { yielded = true; });
      const asyncResult = await vision.diffImagesAsync(before, after, {});
      must(yielded === true, 'setImmediate ran before async diff resolved');
      const syncResult = vision.diffImages(before, after, {});
      must(asyncResult.metrics.diffPixels === syncResult.metrics.diffPixels, 'async metrics match sync');
      must(asyncResult.metrics.comparedPixels === 1000000, 'async compared pixels');
      must(Buffer.compare(asyncResult.highlight, syncResult.highlight) === 0, 'async highlight matches sync');
      // 其它 async 变体与同步一致。
      const cropped = await vision.cropImageAsync(before, { x: 1, y: 2, width: 10, height: 10 });
      must(sameRgba(cropped, vision.cropImage(before, { x: 1, y: 2, width: 10, height: 10 })), 'async crop matches');
      const resized = await vision.resizeImageAsync(before, 1.5, 'bilinear');
      must(sameRgba(resized, vision.resizeImage(before, 1.5, 'bilinear')), 'async resize matches');
      const preprocessed = await vision.preprocessImageAsync(before, [{ op: 'grayscale' }]);
      must(sameRgba(preprocessed, vision.preprocessImage(before, [{ op: 'grayscale' }])), 'async preprocess matches');
      const annotated = await vision.annotateImageAsync(before, [{ kind: 'rect', region: { x: 0, y: 0, width: 5, height: 5 } }]);
      must(sameRgba(annotated, vision.annotateImage(before, [{ kind: 'rect', region: { x: 0, y: 0, width: 5, height: 5 } }])), 'async annotate matches');
      const analysis = await vision.analyzeImageAsync(before);
      must(analysis.pixelCount === 1000000, 'async analyze');
      const edges = await vision.edgeMaskAsync(before, 32);
      must(edges.length === 1000000, 'async edgeMask');
      const found = await vision.findInImageAsync(before, { method: 'color', color: [128, 128, 128], tolerance: 0 });
      must(found.candidates.length === 1, 'async find');
      const encoded = await vision.encodePngRgbaAsync({ width: 4, height: 4, rgba: new Uint8Array(64) });
      must(Buffer.compare(encoded, vision.encodePngRgba({ width: 4, height: 4, rgba: new Uint8Array(64) })) === 0, 'async encode matches');
      const decoded = await vision.decodePngToRgbaAsync(encoded);
      must(decoded.ok === true, 'async decode');
      return true;
    });

    await t('§9.C52', '算法不写文件/不改基线（临时目录保持空）', () => {
      const isolated = join(tempRoot, 'isolated');
      mkdirSync(isolated, { recursive: true });
      const before = makeImage(20, 20, [10, 20, 30, 255]);
      const after = cloneImage(before);
      setPixel(after, 0, 0, [0, 0, 0, 255]);
      vision.diffImages(before, after, {});
      vision.analyzeImage(before);
      vision.findInImage(before, { method: 'color', color: [10, 20, 30] });
      vision.annotateImage(before, [{ kind: 'number', point: { x: 0, y: 0 }, number: 7 }]);
      must(readdirSync(isolated).length === 0, 'algorithm layer creates no files');
      return true;
    });
  } finally {
    try {
      rmSync(tempRoot, { recursive: true, force: true });
    } catch {
      /* 清理失败不影响检查结果，但会在 detail 中由后续报告注明 */
    }
  }
}

/* ------------------------------------------------------------------ */
/* 直接运行时自汇总                                                    */
/* ------------------------------------------------------------------ */

const invokedDirectly = process.argv[1]
  && import.meta.url === pathToFileURL(process.argv[1]).href;

if (invokedDirectly) {
  let passed = 0;
  let failed = 0;
  const failures = [];
  try {
    await runAlgorithmChecks((criteria, label, pass, detail) => {
      if (pass) {
        passed += 1;
        console.log(`PASS ${criteria} ${label}`);
      } else {
        failed += 1;
        failures.push({ criteria, label, detail });
        console.log(`FAIL ${criteria} ${label}`);
        if (detail) console.log(`     ${JSON.stringify(detail)}`);
      }
    });
  } catch (error) {
    failed += 1;
    console.log(`FAIL suite-crash ${error && error.stack ? error.stack : error}`);
  }
  console.log(`\n${passed} passed, ${failed} failed`);
  if (failed > 0) {
    console.log('failures:', JSON.stringify(failures, null, 2));
    process.exitCode = 1;
  } else {
    process.exitCode = 0;
  }
}
