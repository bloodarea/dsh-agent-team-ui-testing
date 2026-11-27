import { deflateSync, inflateSync } from 'node:zlib';
import { fail, hashJson, sha256 } from './json.js';

export const REFERENCE_LIMITS = Object.freeze({ maxBytes: 32 * 1024 * 1024, maxSide: 8192, maxPixels: 24 * 1024 * 1024, maxContours: 4096, maxContourPoints: 65536, maxTotalContourPoints: 262144 });
const signature = Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]);
const identity = [1, 0, 0, 0, 1, 0, 0, 0, 1];
function dimensions(widthPx, heightPx) {
  if (![widthPx, heightPx].every(Number.isSafeInteger) || widthPx < 1 || heightPx < 1 || Math.max(widthPx, heightPx) > REFERENCE_LIMITS.maxSide || widthPx * heightPx > REFERENCE_LIMITS.maxPixels) fail('RESOURCE_LIMIT', 'Reference image dimensions exceed the CPU basic limits.');
}
function crc32(bytes) {
  let crc = 0xffffffff;
  for (const value of bytes) { crc ^= value; for (let bit = 0; bit < 8; bit++) crc = (crc >>> 1) ^ ((crc & 1) ? 0xedb88320 : 0); }
  return (crc ^ 0xffffffff) >>> 0;
}
function chunk(type, bytes) {
  const label = Buffer.from(type, 'ascii'); const result = Buffer.alloc(bytes.length + 12);
  result.writeUInt32BE(bytes.length, 0); label.copy(result, 4); bytes.copy(result, 8); result.writeUInt32BE(crc32(Buffer.concat([label, bytes])), bytes.length + 8); return result;
}
export function encodeRgbaPng(widthPx, heightPx, pixels) {
  dimensions(widthPx, heightPx);
  if (!(pixels instanceof Uint8Array) || pixels.length !== widthPx * heightPx * 4) fail('INVALID_IMAGE', 'RGBA byte count does not match image dimensions.');
  const header = Buffer.alloc(13); header.writeUInt32BE(widthPx, 0); header.writeUInt32BE(heightPx, 4); header[8] = 8; header[9] = 6;
  const rows = Buffer.alloc((widthPx * 4 + 1) * heightPx);
  for (let row = 0; row < heightPx; row++) Buffer.from(pixels.buffer, pixels.byteOffset + row * widthPx * 4, widthPx * 4).copy(rows, row * (widthPx * 4 + 1) + 1);
  return Buffer.concat([signature, chunk('IHDR', header), chunk('sRGB', Buffer.from([0])), chunk('IDAT', deflateSync(rows, { level: 9 })), chunk('IEND', Buffer.alloc(0))]);
}
/** Bounded dependency-free CPU baseline; unsupported decoders/color transforms fail explicitly. */
export function normalizeReferenceImage(input, { frameIndex } = {}) {
  const bytes = Buffer.from(input);
  if (bytes.length > REFERENCE_LIMITS.maxBytes) fail('RESOURCE_LIMIT', 'Reference upload exceeds 32 MiB.');
  if (!bytes.subarray(0, 8).equals(signature)) fail('ALGORITHM_UNAVAILABLE', 'CPU basic decoder currently accepts PNG only; JPEG/EXIF, WebP, GIF and AVIF require a registered decoder.');
  if (frameIndex !== undefined && frameIndex !== 0) fail('ALGORITHM_UNAVAILABLE', 'CPU basic PNG decoder has no animation-frame implementation.');
  let offset = 8; let header; let ended = false; let sawData = false; let dataEnded = false; let srgb = false; const compressed = [];
  while (offset < bytes.length) {
    if (offset + 12 > bytes.length) fail('DECODE_FAILED', 'Truncated PNG chunk.');
    const length = bytes.readUInt32BE(offset); const type = bytes.toString('ascii', offset + 4, offset + 8);
    if (length > REFERENCE_LIMITS.maxBytes || offset + length + 12 > bytes.length) fail('DECODE_FAILED', 'Invalid PNG chunk length.');
    const payload = bytes.subarray(offset + 8, offset + 8 + length);
    if (crc32(bytes.subarray(offset + 4, offset + 8 + length)) !== bytes.readUInt32BE(offset + 8 + length)) fail('DECODE_FAILED', 'PNG CRC mismatch.');
    if (!header && type !== 'IHDR') fail('DECODE_FAILED', 'IHDR must be the first PNG chunk.');
    if (type === 'IHDR') {
      if (header || length !== 13) fail('DECODE_FAILED', 'Invalid or duplicate PNG header.');
      header = { widthPx: payload.readUInt32BE(0), heightPx: payload.readUInt32BE(4), bitDepth: payload[8], colorType: payload[9] }; dimensions(header.widthPx, header.heightPx);
      if (payload[8] !== 8 || ![2, 6].includes(payload[9]) || payload[10] !== 0 || payload[11] !== 0 || payload[12] !== 0) fail('ALGORITHM_UNAVAILABLE', 'CPU basic supports non-interlaced 8-bit RGB/RGBA PNG only.');
    } else if (['iCCP', 'eXIf', 'cHRM', 'gAMA', 'tRNS'].includes(type)) fail('ALGORITHM_UNAVAILABLE', `PNG ${type} needs an explicit registered color/orientation/transparency decoder.`);
    else if (['acTL', 'fcTL', 'fdAT'].includes(type)) fail('ALGORITHM_UNAVAILABLE', 'Animated PNG needs a registered frame decoder and explicit frame selection.');
    else if (type === 'sRGB') { if (srgb || length !== 1 || payload[0] > 3) fail('DECODE_FAILED', 'Invalid PNG sRGB chunk.'); srgb = true; }
    else if (type === 'IDAT') { if (dataEnded) fail('DECODE_FAILED', 'Non-contiguous PNG image data.'); sawData = true; compressed.push(payload); }
    else if (type === 'IEND') { if (length || !sawData) fail('DECODE_FAILED', 'Invalid PNG end chunk.'); ended = true; offset += length + 12; break; }
    else if (/^[A-Z]/.test(type) && type !== 'PLTE') fail('ALGORITHM_UNAVAILABLE', `Unsupported critical PNG chunk ${type}.`);
    if (sawData && type !== 'IDAT' && type !== 'IEND') dataEnded = true;
    offset += length + 12;
  }
  if (!ended || offset !== bytes.length) fail('DECODE_FAILED', 'PNG must end exactly at IEND.');
  const channels = header.colorType === 6 ? 4 : 3; const stride = header.widthPx * channels; const expected = (stride + 1) * header.heightPx;
  const compressedBytes = Buffer.concat(compressed); let decoded;
  try { decoded = inflateSync(compressedBytes, { maxOutputLength: expected, info: true }); } catch { fail('DECODE_FAILED', 'Invalid or over-budget PNG compressed stream.'); }
  const raw = decoded.buffer;
  if (raw.length !== expected || decoded.engine.bytesWritten !== compressedBytes.length) fail('DECODE_FAILED', 'PNG decoded byte count or compressed-stream boundary mismatch.');
  const reconstructed = Buffer.alloc(stride * header.heightPx);
  const paeth = (a, b, c) => { const p = a + b - c; const da = Math.abs(p - a); const db = Math.abs(p - b); const dc = Math.abs(p - c); return da <= db && da <= dc ? a : db <= dc ? b : c; };
  for (let y = 0; y < header.heightPx; y++) {
    const filter = raw[y * (stride + 1)]; if (filter > 4) fail('DECODE_FAILED', 'Unsupported PNG filter.');
    for (let x = 0; x < stride; x++) {
      const left = x >= channels ? reconstructed[y * stride + x - channels] : 0; const up = y ? reconstructed[(y - 1) * stride + x] : 0; const upperLeft = y && x >= channels ? reconstructed[(y - 1) * stride + x - channels] : 0;
      const predictor = [0, left, up, Math.floor((left + up) / 2), paeth(left, up, upperLeft)][filter];
      reconstructed[y * stride + x] = (raw[y * (stride + 1) + x + 1] + predictor) & 255;
    }
  }
  const pixels = Buffer.alloc(header.widthPx * header.heightPx * 4); let transparentPixels = 0;
  for (let p = 0; p < header.widthPx * header.heightPx; p++) {
    pixels[p * 4] = reconstructed[p * channels]; pixels[p * 4 + 1] = reconstructed[p * channels + 1]; pixels[p * 4 + 2] = reconstructed[p * channels + 2]; pixels[p * 4 + 3] = channels === 4 ? reconstructed[p * 4 + 3] : 255;
    if (pixels[p * 4 + 3] !== 255) transparentPixels++;
  }
  const png = encodeRgbaPng(header.widthPx, header.heightPx, pixels);
  const config = { pipelineVersion: 'cpu-basic-png-1.0.0', zlibVersion: process.versions.zlib, colorSpace: 'srgb', bitDepth: 8, alpha: 'preserve', untaggedColorPolicy: 'assume-srgb' };
  return { bytes: png, pixels, mediaType: 'image/png', sourceSha256: sha256(bytes), sha256: sha256(png), widthPx: header.widthPx, heightPx: header.heightPx, transparentPixels, decoder: config.pipelineVersion, configSha256: hashJson(config), assumptions: srgb ? [] : ['Untagged PNG interpreted as sRGB; no ICC transform was applied.'], derivedToSource: [...identity], sourceToDerived: [...identity], metadata: { widthPx: header.widthPx, heightPx: header.heightPx, colorSpace: 'srgb', encoding: 'png', channels: 'RGBA', normalized: true } };
}
export const normalizeReferencePng = normalizeReferenceImage;

export function createRoiMapping({ widthPx, heightPx, rectPx = [0, 0, widthPx, heightPx], outputWidth = rectPx[2], outputHeight = rectPx[3], contentRect = [0, 0, outputWidth, outputHeight] }) {
  dimensions(widthPx, heightPx); dimensions(outputWidth, outputHeight);
  if (![...rectPx, ...contentRect].every(Number.isFinite) || rectPx.length !== 4 || contentRect.length !== 4 || rectPx.some(value => !Number.isInteger(value)) || rectPx[0] < 0 || rectPx[1] < 0 || rectPx[2] <= 0 || rectPx[3] <= 0 || rectPx[0] + rectPx[2] > widthPx || rectPx[1] + rectPx[3] > heightPx || contentRect[0] < 0 || contentRect[1] < 0 || contentRect[2] <= 0 || contentRect[3] <= 0 || contentRect[0] + contentRect[2] > outputWidth || contentRect[1] + contentRect[3] > outputHeight) fail('INVALID_ROI', 'ROI/content must be valid half-open rectangles inside their images.');
  const sx = rectPx[2] / contentRect[2]; const sy = rectPx[3] / contentRect[3]; const tx = rectPx[0] - contentRect[0] * sx; const ty = rectPx[1] - contentRect[1] * sy;
  return { widthPx, heightPx, outputWidth, outputHeight, rectPx: [...rectPx], contentRect: [...contentRect], derivedToSource: [sx, 0, tx, 0, sy, ty, 0, 0, 1], sourceToDerived: [1 / sx, 0, -tx / sx, 0, 1 / sy, -ty / sy, 0, 0, 1], coordinateConvention: 'top-left-pixel-boundary-half-open', resampling: sx > 1 || sy > 1 ? 'area' : 'bilinear' };
}
function project(matrix, point) { const [x, y] = point; const w = matrix[6] * x + matrix[7] * y + matrix[8]; if (!Number.isFinite(w) || Math.abs(w) < 1e-12) fail('INVALID_MAPPING', 'Degenerate homogeneous mapping.'); return [(matrix[0] * x + matrix[1] * y + matrix[2]) / w, (matrix[3] * x + matrix[4] * y + matrix[5]) / w]; }
export function mapPointToSource(mapping, point) {
  if (!Array.isArray(point) || point.length !== 2 || !point.every(Number.isFinite)) fail('INVALID_POINT', 'Expected a finite pixel-boundary point.');
  const [x, y, w, h] = mapping.contentRect;
  if (point[0] < x || point[1] < y || point[0] >= x + w || point[1] >= y + h) fail('PADDING_POINT', 'Point is outside actual derived image content.');
  return project(mapping.derivedToSource, point);
}
export function mapPointFromSource(mapping, point) {
  const [x, y, w, h] = mapping.rectPx;
  if (!Array.isArray(point) || point.length !== 2 || !point.every(Number.isFinite) || point[0] < x || point[1] < y || point[0] >= x + w || point[1] >= y + h) fail('INVALID_POINT', 'Source point is outside ROI.');
  return project(mapping.sourceToDerived, point);
}
export function mapRectToSource(mapping, rect) {
  if (!Array.isArray(rect) || rect.length !== 4 || !rect.every(Number.isFinite) || rect[2] <= 0 || rect[3] <= 0) fail('INVALID_ROI', 'Expected finite positive rectangle.');
  const c = mapping.contentRect; const x = Math.max(rect[0], c[0]); const y = Math.max(rect[1], c[1]); const right = Math.min(rect[0] + rect[2], c[0] + c[2]); const bottom = Math.min(rect[1] + rect[3], c[1] + c[3]);
  if (right <= x || bottom <= y) return null;
  const points = [[x, y], [right, y], [x, bottom], [right, bottom]].map(point => project(mapping.derivedToSource, point));
  const left = Math.max(0, Math.floor(Math.min(...points.map(p => p[0])))); const top = Math.max(0, Math.floor(Math.min(...points.map(p => p[1]))));
  const r = Math.min(mapping.widthPx, Math.ceil(Math.max(...points.map(p => p[0])))); const b = Math.min(mapping.heightPx, Math.ceil(Math.max(...points.map(p => p[1]))));
  return [left, top, Math.max(0, r - left), Math.max(0, b - top)];
}

/**
 * Extract 0/255 bytes without mutating RGBA. Predicates are inclusive:
 * {type:'alpha', threshold:128} selects alpha >= threshold (0..255);
 * {type:'colorDistance', color:[r,g,b], tolerance:20} selects Euclidean
 * distance <= tolerance in encoded sRGB byte space, ignoring alpha.
 * Raster dimensions/coordinates refer to the input source image, without scaling.
 */
export function extractMask(rgba, { widthPx, heightPx, predicate } = {}) {
  dimensions(widthPx, heightPx);
  if (!(rgba instanceof Uint8Array) || rgba.length !== widthPx * heightPx * 4) fail('INVALID_IMAGE', 'RGBA byte count does not match mask dimensions.');
  if (!predicate || typeof predicate !== 'object') fail('INVALID_PREDICATE', 'An explicit alpha or colorDistance predicate is required.');
  const { type, threshold, color, tolerance } = predicate;
  if (type === 'alpha') {
    if (!Number.isFinite(threshold) || threshold < 0 || threshold > 255) fail('INVALID_PREDICATE', 'Alpha threshold must be finite and within 0..255.');
  } else if (type === 'colorDistance') {
    if (!Array.isArray(color) || color.length !== 3 || !Array.from(color).every(value => Number.isFinite(value) && value >= 0 && value <= 255) || !Number.isFinite(tolerance) || tolerance < 0) fail('INVALID_PREDICATE', 'Color distance needs three finite sRGB bytes and a finite nonnegative RGB-distance tolerance.');
  } else fail('INVALID_PREDICATE', 'Supported mask predicates are alpha and colorDistance.');
  const totalPixels = widthPx * heightPx; const mask = new Uint8Array(totalPixels); let foregroundPixels = 0;
  for (let pixel = 0; pixel < totalPixels; pixel++) {
    const offset = pixel * 4;
    const selected = type === 'alpha' ? rgba[offset + 3] >= threshold : Math.hypot(rgba[offset] - color[0], rgba[offset + 1] - color[1], rgba[offset + 2] - color[2]) <= tolerance;
    if (selected) { mask[pixel] = 255; foregroundPixels++; }
  }
  return { mask, widthPx, heightPx, foregroundPixels, totalPixels, coverageRatio: foregroundPixels / totalPixels };
}

function finitePoints(points, minimum = 1) {
  if (!Array.isArray(points) || points.length < minimum) fail('INVALID_CONTOUR', `Expected at least ${minimum} finite [x,y] contour points.`);
  if (points.length > REFERENCE_LIMITS.maxContourPoints) fail('OUTPUT_LIMIT', 'Contour point limit exceeded.');
  for (const point of points) if (!Array.isArray(point) || point.length !== 2 || !Number.isFinite(point[0]) || !Number.isFinite(point[1])) fail('INVALID_CONTOUR', 'Contour points must be finite [x,y] pixel-boundary coordinates.');
}
/** Pixel-boundary AABB: width = maxX - minX, height = maxY - minY (no +1). */
export function bboxOfContour(points) {
  finitePoints(points);
  let x = Infinity; let y = Infinity; let right = -Infinity; let bottom = -Infinity;
  for (const [px, py] of points) { x = Math.min(x, px); y = Math.min(y, py); right = Math.max(right, px); bottom = Math.max(bottom, py); }
  const bbox = { x, y, width: right - x, height: bottom - y };
  if (!Object.values(bbox).every(Number.isFinite)) fail('INVALID_CONTOUR', 'Contour bounding box is not finite.');
  return bbox;
}
function polygonGeometry(points) {
  finitePoints(points, 3);
  // Translate before the shoelace sums to preserve small polygons at large origins.
  const [originX, originY] = points[0]; let twiceArea = 0; let sumX = 0; let sumY = 0;
  for (let index = 0; index < points.length; index++) {
    const next = points[(index + 1) % points.length];
    const x = points[index][0] - originX; const y = points[index][1] - originY; const nx = next[0] - originX; const ny = next[1] - originY;
    const cross = x * ny - nx * y; twiceArea += cross; sumX += (x + nx) * cross; sumY += (y + ny) * cross;
  }
  const signedAreaPx = twiceArea / 2; const centroidPx = [originX + sumX / (3 * twiceArea), originY + sumY / (3 * twiceArea)];
  if (!signedAreaPx || ![signedAreaPx, ...centroidPx].every(Number.isFinite)) fail('INVALID_CONTOUR', 'Contour must enclose a finite nonzero area.');
  return { areaPx: Math.abs(signedAreaPx), signedAreaPx, centroidPx };
}

/**
 * Trace exposed pixel-square edges, using 4-connected foreground (never 8):
 * diagonal-only pixels produce separate loops. At a shared vertex the rightmost
 * turn wins. Coordinates use the source raster's top-left pixel boundaries, so
 * one pixel has a 1x1 box and a centroid at [x+0.5,y+0.5]. Points are ordered and
 * closed (last equals first); outer loops have positive signed area in y-down
 * coordinates, holes negative. Holes are separate contours with isHole:true.
 * minAreaPx filters each loop by absolute polygon area, including hole loops.
 * Limits count all traced loops/points BEFORE filtering; no partial result leaks.
 * If operating on an ROI raster, explicitly map its points back to the source
 * with the existing ROI mapping helpers before comparing source coordinates.
 */
export function traceContours(mask, { widthPx, heightPx, minAreaPx = 0 } = {}) {
  dimensions(widthPx, heightPx);
  if (!(mask instanceof Uint8Array) || mask.length !== widthPx * heightPx) fail('INVALID_MASK', 'Mask byte count does not match image dimensions.');
  if (!Number.isFinite(minAreaPx) || minAreaPx < 0) fail('INVALID_CONTOUR', 'minAreaPx must be finite and nonnegative.');
  const edges = new Uint8Array(mask.length); let foregroundPixels = 0; let edgeCount = 0;
  for (const value of mask) {
    if (value !== 0 && value !== 255) fail('INVALID_MASK', 'Binary mask bytes must be 0 or 255.');
    if (value) foregroundPixels++;
  }
  if (!foregroundPixels) fail('EMPTY_MASK', 'Cannot trace an empty foreground mask.');
  for (let index = 0; index < mask.length; index++) {
    if (!mask[index]) continue;
    const x = index % widthPx; const y = Math.floor(index / widthPx); let flags = 0;
    // Edge directions E,S,W,N keep the foreground square on the right.
    if (y === 0 || !mask[index - widthPx]) flags |= 1;
    if (x === widthPx - 1 || !mask[index + 1]) flags |= 2;
    if (y === heightPx - 1 || !mask[index + widthPx]) flags |= 4;
    if (x === 0 || !mask[index - 1]) flags |= 8;
    edges[index] = flags;
    edgeCount += (flags & 1) + ((flags >> 1) & 1) + ((flags >> 2) & 1) + ((flags >> 3) & 1);
    if (edgeCount > REFERENCE_LIMITS.maxTotalContourPoints) fail('OUTPUT_LIMIT', 'Total contour point limit exceeded.');
  }
  const startX = [0, 1, 1, 0]; const startY = [0, 0, 1, 1]; const dx = [1, 0, -1, 0]; const dy = [0, 1, 0, -1];
  const contours = []; let tracedLoops = 0; let totalPoints = 0;
  for (let seed = 0; seed < edges.length; seed++) {
    for (let direction = 0; direction < 4; direction++) {
      if (!(edges[seed] & (1 << direction))) continue;
      if (++tracedLoops > REFERENCE_LIMITS.maxContours) fail('OUTPUT_LIMIT', 'Contour count limit exceeded.');
      const firstEdge = seed * 4 + direction; let current = firstEdge; const points = [];
      for (;;) {
        const pixel = Math.floor(current / 4); const dir = current % 4;
        const x = pixel % widthPx + startX[dir]; const y = Math.floor(pixel / widthPx) + startY[dir];
        points.push([x, y]);
        if (points.length + 1 > REFERENCE_LIMITS.maxContourPoints || ++totalPoints > REFERENCE_LIMITS.maxTotalContourPoints) fail('OUTPUT_LIMIT', 'Contour point limit exceeded.');
        edges[pixel] &= ~(1 << dir);
        const endX = x + dx[dir]; const endY = y + dy[dir]; let nextEdge = -1;
        // Right, straight, left, reverse is the explicit 4-neighbour tie-break.
        for (const nextDir of [(dir + 1) % 4, dir, (dir + 3) % 4, (dir + 2) % 4]) {
          const px = endX - startX[nextDir]; const py = endY - startY[nextDir];
          if (px < 0 || py < 0 || px >= widthPx || py >= heightPx) continue;
          const candidate = (py * widthPx + px) * 4 + nextDir;
          if (candidate === firstEdge || (edges[py * widthPx + px] & (1 << nextDir))) { nextEdge = candidate; break; }
        }
        if (nextEdge === firstEdge) break;
        if (nextEdge < 0) fail('INVALID_CONTOUR', 'Mask boundary failed to form a closed contour.');
        current = nextEdge;
      }
      points.push([...points[0]]);
      if (++totalPoints > REFERENCE_LIMITS.maxTotalContourPoints) fail('OUTPUT_LIMIT', 'Total contour point limit exceeded.');
      const geometry = polygonGeometry(points);
      if (geometry.areaPx >= minAreaPx) contours.push({ points, ...geometry, isHole: geometry.signedAreaPx < 0, imageAreaPx: mask.length });
    }
  }
  return { contours, widthPx, heightPx, foregroundPixels, coverageRatio: foregroundPixels / mask.length, connectivity: 4, coordinateConvention: 'top-left-pixel-boundary-half-open' };
}

/**
 * contours accepts traceContours(...) or its .contours array (also raw point
 * arrays). Traced contours carry imageAreaPx, the SOURCE image area denominator
 * for areaRatio. Raw point arrays lack that evidence: areaRatio stays unknown.
 * Count includes hole loops; area/centroid subtract holes. A supplied bbox must
 * have positive dimensions; otherwise it is derived from the contour union.
 * expect keys: contourCount, areaRatio (0..1), aspectRatio (>0), centroidPx ([x,y]).
 * Each is a value or {value, tolerance}; tolerance is absolute (Euclidean pixels
 * for centroid), defaults to zero, and must be finite/nonnegative. Missing/null
 * expected or observed values mean unknown. Overall: fail > unknown > pass;
 * therefore a partial set of passing expectations never becomes overall pass.
 */
export function checkBasicGeometry({ contours, bbox, expect = {} } = {}) {
  if (!expect || typeof expect !== 'object' || Array.isArray(expect)) fail('INVALID_EXPECTATION', 'Geometry expectations must be an object.');
  let list = contours; let imageAreaPx = null;
  if (contours !== undefined && !Array.isArray(contours)) {
    if (!contours || !Array.isArray(contours.contours)) fail('INVALID_CONTOUR', 'Expected contour array or traceContours result.');
    dimensions(contours.widthPx, contours.heightPx); imageAreaPx = contours.widthPx * contours.heightPx; list = contours.contours;
  }
  if (list && list.length > REFERENCE_LIMITS.maxContours) fail('OUTPUT_LIMIT', 'Contour count limit exceeded.');
  let areaPx = 0; let weightedX = 0; let weightedY = 0; let totalPoints = 0; let union;
  if (list) for (const contour of list) {
    const points = Array.isArray(contour) ? contour : contour?.points;
    const geometry = polygonGeometry(points); totalPoints += points.length;
    if (totalPoints > REFERENCE_LIMITS.maxTotalContourPoints) fail('OUTPUT_LIMIT', 'Total contour point limit exceeded.');
    if (!Array.isArray(contour) && contour.isHole !== undefined && typeof contour.isHole !== 'boolean') fail('INVALID_CONTOUR', 'isHole must be boolean.');
    const signedArea = contour.isHole ? -geometry.areaPx : geometry.areaPx;
    areaPx += signedArea; weightedX += signedArea * geometry.centroidPx[0]; weightedY += signedArea * geometry.centroidPx[1];
    const box = bboxOfContour(points);
    if (!union) union = box;
    else { const right = Math.max(union.x + union.width, box.x + box.width); const bottom = Math.max(union.y + union.height, box.y + box.height); union.x = Math.min(union.x, box.x); union.y = Math.min(union.y, box.y); union.width = right - union.x; union.height = bottom - union.y; }
    if (!Array.isArray(contour) && contour.imageAreaPx !== undefined) {
      if (!Number.isSafeInteger(contour.imageAreaPx) || contour.imageAreaPx <= 0 || contour.imageAreaPx > REFERENCE_LIMITS.maxPixels || (imageAreaPx !== null && imageAreaPx !== contour.imageAreaPx)) fail('INVALID_CONTOUR', 'Contours must share a valid source image area.');
      imageAreaPx = contour.imageAreaPx;
    }
  }
  if (list && (!Number.isFinite(areaPx) || areaPx < 0 || (imageAreaPx !== null && areaPx > imageAreaPx))) fail('INVALID_CONTOUR', 'Contour foreground area is inconsistent with source image area or holes.');
  const box = bbox === undefined ? union : bbox;
  if (box && (![box.x, box.y, box.width, box.height].every(Number.isFinite) || box.width <= 0 || box.height <= 0)) fail('INVALID_GEOMETRY', 'Bounding box needs finite coordinates and positive width/height.');
  if (bbox !== undefined && !box) fail('INVALID_GEOMETRY', 'Bounding box must be an object.');
  const centroidPx = list && areaPx > 0 ? [weightedX / areaPx, weightedY / areaPx] : null;
  if (centroidPx && !centroidPx.every(Number.isFinite)) fail('INVALID_CONTOUR', 'Contour centroid is not finite.');
  const observations = [
    ['contourCount', 'contour-count', 'count', list ? list.length : null],
    ['areaRatio', 'foreground-area/source-image-area', 'ratio', list && imageAreaPx !== null ? areaPx / imageAreaPx : null],
    ['aspectRatio', 'bbox-width/height', 'ratio', box ? box.width / box.height : null],
    ['centroidPx', 'foreground-centroid', 'px', centroidPx],
  ];
  const checks = observations.map(([id, metric, unit, observed]) => {
    const spec = expect[id]; const structured = spec !== null && typeof spec === 'object' && !Array.isArray(spec);
    const expected = (structured ? spec.value : spec) ?? null; const tolerance = structured ? (spec.tolerance ?? 0) : 0;
    if (!Number.isFinite(tolerance) || tolerance < 0) fail('INVALID_EXPECTATION', `${id} tolerance must be finite and nonnegative.`);
    if (expected !== null) {
      if (id === 'centroidPx' ? !Array.isArray(expected) || expected.length !== 2 || !Number.isFinite(expected[0]) || !Number.isFinite(expected[1]) : !Number.isFinite(expected) || (id === 'contourCount' && (!Number.isSafeInteger(expected) || expected < 0)) || (id === 'areaRatio' && (expected < 0 || expected > 1)) || (id === 'aspectRatio' && expected <= 0)) fail('INVALID_EXPECTATION', `${id} has an invalid expected value.`);
    }
    if (observed !== null && (Array.isArray(observed) ? !observed.every(Number.isFinite) : !Number.isFinite(observed))) fail('INVALID_GEOMETRY', `${id} observed value is not finite.`);
    const distance = expected === null || observed === null ? null : id === 'centroidPx' ? Math.hypot(observed[0] - expected[0], observed[1] - expected[1]) : Math.abs(observed - expected);
    return { id, metric, unit, expected, observed, tolerance, verdict: distance === null ? 'unknown' : distance <= tolerance ? 'pass' : 'fail' };
  });
  return { verdict: checks.some(check => check.verdict === 'fail') ? 'fail' : checks.some(check => check.verdict === 'unknown') ? 'unknown' : 'pass', checks };
}
