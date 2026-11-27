import test from 'node:test';
import assert from 'node:assert/strict';
import {
  REFERENCE_LIMITS, encodeRgbaPng, normalizeReferenceImage,
  extractMask, traceContours, bboxOfContour, checkBasicGeometry,
  createRoiMapping, mapPointToSource, mapPointFromSource,
} from '../../targets/three-d/spec/reference.js';

const throwsCode = (fn, code) => assert.throws(fn, error => error.code === code && error.effectState === 'none');
const near = (actual, expected) => assert.ok(Math.abs(actual - expected) < 1e-10, `${actual} != ${expected}`);
function raster(widthPx, heightPx, select) {
  return Uint8Array.from({ length: widthPx * heightPx }, (_, index) => select(index % widthPx, Math.floor(index / widthPx)) ? 255 : 0);
}
function rectangle() {
  return traceContours(raster(10, 8, (x, y) => x >= 2 && x < 6 && y >= 3 && y < 5), { widthPx: 10, heightPx: 8 });
}
const rectangleExpect = { contourCount: 1, areaRatio: 0.1, aspectRatio: 2, centroidPx: [4, 4] };
const byId = report => Object.fromEntries(report.checks.map(check => [check.id, check]));

test('alpha mask threshold is inclusive, byte-valued, deterministic and immutable', () => {
  const rgba = Uint8Array.from([1, 2, 3, 0, 4, 5, 6, 127, 7, 8, 9, 128, 10, 11, 12, 255]);
  const before = rgba.slice();
  const result = extractMask(rgba, { widthPx: 4, heightPx: 1, predicate: { type: 'alpha', threshold: 128 } });
  assert.ok(result.mask instanceof Uint8Array);
  assert.deepEqual([...result.mask], [0, 0, 255, 255]);
  assert.deepEqual([result.widthPx, result.heightPx, result.foregroundPixels, result.totalPixels, result.coverageRatio], [4, 1, 2, 4, 0.5]);
  assert.deepEqual(rgba, before);
  assert.deepEqual([...extractMask(rgba, { widthPx: 4, heightPx: 1, predicate: { type: 'alpha', threshold: 0 } }).mask], [255, 255, 255, 255]);
  assert.deepEqual([...extractMask(rgba, { widthPx: 4, heightPx: 1, predicate: { type: 'alpha', threshold: 255 } }).mask], [0, 0, 0, 255]);
});

test('color mask uses inclusive Euclidean sRGB distance and explicitly ignores alpha', () => {
  const rgba = Uint8Array.from([10, 20, 30, 0, 13, 24, 30, 255, 16, 20, 30, 255, 10, 20, 30, 128]);
  const result = extractMask(rgba, { widthPx: 2, heightPx: 2, predicate: { type: 'colorDistance', color: [10, 20, 30], tolerance: 5 } });
  assert.deepEqual([...result.mask], [255, 255, 0, 255]);
  assert.equal(result.foregroundPixels, 3);
  assert.equal(result.coverageRatio, 0.75);
});

test('normalized synthetic PNG pixels feed the CPU mask directly', () => {
  const pixels = Buffer.from([255, 0, 0, 255, 0, 0, 255, 0]);
  const image = normalizeReferenceImage(encodeRgbaPng(2, 1, pixels));
  const result = extractMask(image.pixels, { ...image, predicate: { type: 'alpha', threshold: 1 } });
  assert.deepEqual([...result.mask], [255, 0]);
});

test('extractMask rejects mismatched bytes, non-finite dimensions and invalid predicates', () => {
  const rgba = new Uint8Array(4);
  throwsCode(() => extractMask(rgba, { widthPx: 2, heightPx: 1, predicate: { type: 'alpha', threshold: 1 } }), 'INVALID_IMAGE');
  throwsCode(() => extractMask([], { widthPx: 1, heightPx: 1 }), 'INVALID_IMAGE');
  for (const widthPx of [0, -1, 1.5, NaN, Infinity, REFERENCE_LIMITS.maxSide + 1]) throwsCode(() => extractMask(rgba, { widthPx, heightPx: 1 }), 'RESOURCE_LIMIT');
  for (const predicate of [undefined, {}, { type: 'alpha' }, { type: 'alpha', threshold: NaN }, { type: 'alpha', threshold: -1 }, { type: 'alpha', threshold: 256 }, { type: 'other' }, { type: 'colorDistance', color: [0, 0, Infinity], tolerance: 1 }, { type: 'colorDistance', color: [0, 0], tolerance: 1 }, { type: 'colorDistance', color: [0, 0, 0], tolerance: -1 }, { type: 'colorDistance', color: [0, 0, 0], tolerance: Infinity }]) {
    throwsCode(() => extractMask(rgba, { widthPx: 1, heightPx: 1, predicate }), 'INVALID_PREDICATE');
  }
});

test('empty foreground retains zero extraction statistics but tracing throws EMPTY_MASK', () => {
  const result = extractMask(new Uint8Array(16), { widthPx: 2, heightPx: 2, predicate: { type: 'alpha', threshold: 1 } });
  assert.equal(result.coverageRatio, 0);
  assert.equal(result.foregroundPixels, 0);
  throwsCode(() => traceContours(result.mask, result), 'EMPTY_MASK');
});

test('single rectangle has ordered closed source-boundary contour, exact area, bbox and centroid', () => {
  const result = rectangle();
  assert.equal(result.contours.length, 1);
  const contour = result.contours[0];
  assert.deepEqual(contour.points[0], [2, 3]);
  assert.deepEqual(contour.points.at(-1), contour.points[0]);
  assert.equal(contour.points.length, 13);
  assert.equal(contour.areaPx, 8);
  assert.equal(contour.signedAreaPx, 8);
  assert.equal(contour.isHole, false);
  assert.deepEqual(contour.centroidPx, [4, 4]);
  assert.deepEqual(bboxOfContour(contour.points), { x: 2, y: 3, width: 4, height: 2 });
  assert.equal(result.coverageRatio, 0.1);
  assert.equal(result.coordinateConvention, 'top-left-pixel-boundary-half-open');
});

test('full raster border includes right/bottom pixel boundaries without +1 inflation', () => {
  const mask = new Uint8Array(6).fill(255); const before = mask.slice();
  const result = traceContours(mask, { widthPx: 3, heightPx: 2 });
  assert.equal(result.contours[0].areaPx, 6);
  assert.deepEqual(bboxOfContour(result.contours[0].points), { x: 0, y: 0, width: 3, height: 2 });
  assert.deepEqual(result.contours[0].centroidPx, [1.5, 1]);
  assert.deepEqual(mask, before);
});

test('4-neighbour foreground keeps diagonal-only pixels separate (not 8-neighbour)', () => {
  const result = traceContours(Uint8Array.from([255, 0, 0, 255]), { widthPx: 2, heightPx: 2 });
  assert.equal(result.connectivity, 4);
  assert.equal(result.contours.length, 2);
  assert.deepEqual(result.contours.map(contour => contour.areaPx), [1, 1]);
  assert.deepEqual(result.contours.map(contour => contour.centroidPx), [[0.5, 0.5], [1.5, 1.5]]);
});

test('4-neighbour foreground joins edge-sharing pixels into one boundary', () => {
  const result = traceContours(Uint8Array.from([255, 255]), { widthPx: 2, heightPx: 1 });
  assert.equal(result.contours.length, 1);
  assert.equal(result.contours[0].areaPx, 2);
});

test('hole boundaries are explicit negative loops and net area/centroid subtract them', () => {
  const result = traceContours(raster(5, 5, (x, y) => x === 0 || y === 0 || x === 4 || y === 4), { widthPx: 5, heightPx: 5 });
  assert.equal(result.contours.length, 2);
  assert.deepEqual(result.contours.map(contour => [contour.areaPx, contour.signedAreaPx, contour.isHole]), [[25, 25, false], [9, -9, true]]);
  const report = checkBasicGeometry({ contours: result, expect: { contourCount: 2, areaRatio: 16 / 25, aspectRatio: 1, centroidPx: [2.5, 2.5] } });
  assert.equal(report.verdict, 'pass');
});

test('off-centre hole shifts the area-weighted centroid rather than averaging loop centres', () => {
  const result = traceContours(raster(5, 4, (x, y) => !(x === 1 && y === 1)), { widthPx: 5, heightPx: 4 });
  const report = byId(checkBasicGeometry({ contours: result }));
  near(report.centroidPx.observed[0], (20 * 2.5 - 1.5) / 19);
  near(report.centroidPx.observed[1], (20 * 2 - 1.5) / 19);
  near(report.areaRatio.observed, 19 / 20);
});

test('concave L contour area and centroid reflect covered pixel squares', () => {
  const result = traceContours(Uint8Array.from([255, 0, 255, 255]), { widthPx: 2, heightPx: 2 });
  assert.equal(result.contours.length, 1);
  assert.equal(result.contours[0].areaPx, 3);
  near(result.contours[0].centroidPx[0], 5 / 6);
  near(result.contours[0].centroidPx[1], 7 / 6);
});

test('minAreaPx is inclusive and may intentionally filter every valid contour', () => {
  const mask = Uint8Array.from([255, 0, 255, 255]);
  const result = traceContours(mask, { widthPx: 4, heightPx: 1, minAreaPx: 2 });
  assert.equal(result.contours.length, 1);
  assert.equal(result.contours[0].areaPx, 2);
  assert.equal(result.foregroundPixels, 3);
  assert.deepEqual(traceContours(mask, { widthPx: 4, heightPx: 1, minAreaPx: 3 }).contours, []);
});

test('traceContours rejects empty byte arrays, dimension mismatch, nonbinary and non-finite inputs', () => {
  throwsCode(() => traceContours(new Uint8Array(), { widthPx: 1, heightPx: 1 }), 'INVALID_MASK');
  throwsCode(() => traceContours(new Uint8Array(3), { widthPx: 2, heightPx: 2 }), 'INVALID_MASK');
  throwsCode(() => traceContours([255], { widthPx: 1, heightPx: 1 }), 'INVALID_MASK');
  throwsCode(() => traceContours(Uint8Array.of(1), { widthPx: 1, heightPx: 1 }), 'INVALID_MASK');
  for (const value of [NaN, Infinity, -1]) throwsCode(() => traceContours(Uint8Array.of(255), { widthPx: 1, heightPx: 1, minAreaPx: value }), 'INVALID_CONTOUR');
  throwsCode(() => traceContours(Uint8Array.of(255), { widthPx: Infinity, heightPx: 1 }), 'RESOURCE_LIMIT');
});

test('bboxOfContour supports subpixel source points and rejects empty/non-finite geometry', () => {
  assert.deepEqual(bboxOfContour([[2.5, 3.25], [6.75, 4.5]]), { x: 2.5, y: 3.25, width: 4.25, height: 1.25 });
  for (const points of [[], [[NaN, 0]], [[0, Infinity]], [[0]], [null], [[-Number.MAX_VALUE, 0], [Number.MAX_VALUE, 1]]]) throwsCode(() => bboxOfContour(points), 'INVALID_CONTOUR');
});

test('ROI contour points round-trip to source coordinates with matching boundary convention', () => {
  const mapping = createRoiMapping({ widthPx: 100, heightPx: 80, rectPx: [20, 10, 40, 30], outputWidth: 20, outputHeight: 15 });
  const result = traceContours(raster(20, 15, (x, y) => x >= 2 && x < 6 && y >= 3 && y < 5), { widthPx: 20, heightPx: 15 });
  const sourcePoints = result.contours[0].points.map(point => mapPointToSource(mapping, point));
  assert.deepEqual(bboxOfContour(sourcePoints), { x: 24, y: 16, width: 8, height: 4 });
  assert.deepEqual(sourcePoints.map(point => mapPointFromSource(mapping, point)), result.contours[0].points);
});

test('complete geometry expectations pass and expose every required check field', () => {
  const result = checkBasicGeometry({ contours: rectangle(), expect: rectangleExpect });
  assert.equal(result.verdict, 'pass');
  assert.equal(result.checks.length, 4);
  for (const check of result.checks) {
    assert.deepEqual(Object.keys(check).sort(), ['id', 'metric', 'unit', 'expected', 'observed', 'tolerance', 'verdict'].sort());
    assert.equal(check.verdict, 'pass');
  }
  assert.equal(byId(result).centroidPx.unit, 'px');
});

test('missing expectation means unknown for every check and overall, never default pass', () => {
  const result = checkBasicGeometry({ contours: rectangle() });
  assert.equal(result.verdict, 'unknown');
  assert.ok(result.checks.every(check => check.expected === null && check.observed !== null && check.verdict === 'unknown'));
});

test('partial/null expectations keep aggregate unknown even when supplied checks pass', () => {
  for (const expect of [{ contourCount: 1 }, { ...rectangleExpect, centroidPx: null }, { ...rectangleExpect, areaRatio: {} }]) {
    const result = checkBasicGeometry({ contours: rectangle(), expect });
    assert.equal(result.verdict, 'unknown');
    assert.ok(result.checks.some(check => check.verdict === 'pass'));
    assert.ok(result.checks.some(check => check.verdict === 'unknown'));
  }
});

test('known failure dominates unknown and centroid comparison uses source pixels', () => {
  const result = checkBasicGeometry({ contours: rectangle(), expect: { centroidPx: [0, 0] } });
  assert.equal(result.verdict, 'fail');
  assert.equal(byId(result).centroidPx.verdict, 'fail');
  assert.equal(byId(result).contourCount.verdict, 'unknown');
});

test('absolute tolerances are inclusive and centroid tolerance is Euclidean distance', () => {
  const expect = { ...rectangleExpect, aspectRatio: { value: 2.5, tolerance: 0.5 }, centroidPx: { value: [7, 8], tolerance: 5 } };
  assert.equal(checkBasicGeometry({ contours: rectangle(), expect }).verdict, 'pass');
  assert.equal(checkBasicGeometry({ contours: rectangle(), expect: { ...expect, centroidPx: { value: [7, 8], tolerance: 4.99 } } }).verdict, 'fail');
});

test('trace .contours array preserves source area evidence for the same observations', () => {
  const result = rectangle();
  assert.deepEqual(checkBasicGeometry({ contours: result.contours, expect: rectangleExpect }), checkBasicGeometry({ contours: result, expect: rectangleExpect }));
});

test('raw point polygons without source image area cannot manufacture areaRatio evidence', () => {
  const result = checkBasicGeometry({ contours: rectangle().contours.map(contour => contour.points), expect: rectangleExpect });
  assert.equal(result.verdict, 'unknown');
  assert.equal(byId(result).areaRatio.observed, null);
  assert.equal(byId(result).areaRatio.verdict, 'unknown');
  assert.equal(byId(result).centroidPx.verdict, 'pass');
});

test('absent observations remain unknown and a supplied bbox only proves aspect ratio', () => {
  assert.ok(checkBasicGeometry({ expect: rectangleExpect }).checks.every(check => check.verdict === 'unknown'));
  const result = checkBasicGeometry({ bbox: { x: 0, y: 0, width: 4, height: 2 }, expect: rectangleExpect });
  assert.equal(result.verdict, 'unknown');
  assert.equal(byId(result).aspectRatio.verdict, 'pass');
  assert.equal(byId(result).centroidPx.observed, null);
});

test('geometry rejects non-finite expectations, tolerances, polygons, bboxes and inconsistent image areas', () => {
  const contours = rectangle();
  for (const expect of [{ contourCount: NaN }, { contourCount: 1.5 }, { areaRatio: Infinity }, { areaRatio: -1 }, { areaRatio: 2 }, { aspectRatio: 0 }, { centroidPx: [0, NaN] }, { centroidPx: [0] }, { contourCount: { value: 1, tolerance: -1 } }, { areaRatio: { value: 0.1, tolerance: Infinity } }]) throwsCode(() => checkBasicGeometry({ contours, expect }), 'INVALID_EXPECTATION');
  for (const bbox of [null, {}, { x: 0, y: 0, width: 0, height: 1 }, { x: NaN, y: 0, width: 1, height: 1 }]) throwsCode(() => checkBasicGeometry({ contours, bbox }), 'INVALID_GEOMETRY');
  throwsCode(() => checkBasicGeometry({ contours: [{ points: [[0, 0], [0, 0], [0, 0]] }] }), 'INVALID_CONTOUR');
  throwsCode(() => checkBasicGeometry({ contours: [{ points: [[0, 0], [1, 0], [NaN, 1]] }] }), 'INVALID_CONTOUR');
  throwsCode(() => checkBasicGeometry({ contours: [{ ...contours.contours[0], imageAreaPx: Infinity }] }), 'INVALID_CONTOUR');
  throwsCode(() => checkBasicGeometry({ contours: { ...contours, contours: [{ ...contours.contours[0], imageAreaPx: 1 }] } }), 'INVALID_CONTOUR');
});

test('geometry recomputes measured area and centroid instead of trusting stale cached claims', () => {
  const contours = rectangle();
  contours.contours[0].areaPx = 999;
  contours.contours[0].centroidPx = [999, 999];
  assert.equal(checkBasicGeometry({ contours, expect: rectangleExpect }).verdict, 'pass');
});

test('contour count over limit throws OUTPUT_LIMIT even when minAreaPx would filter loops', () => {
  const widthPx = Math.ceil(Math.sqrt(REFERENCE_LIMITS.maxContours * 2)) + 2;
  const mask = raster(widthPx, widthPx, (x, y) => (x + y) % 2 === 0);
  throwsCode(() => traceContours(mask, { widthPx, heightPx: widthPx, minAreaPx: 100 }), 'OUTPUT_LIMIT');
});

test('single comb boundary over per-contour point budget throws OUTPUT_LIMIT', () => {
  const widthPx = 256; const heightPx = 256;
  const mask = raster(widthPx, heightPx, (x, y) => y === heightPx - 1 || x % 2 === 0);
  throwsCode(() => traceContours(mask, { widthPx, heightPx }), 'OUTPUT_LIMIT');
  throwsCode(() => bboxOfContour(Array.from({ length: REFERENCE_LIMITS.maxContourPoints + 1 }, () => [0, 0])), 'OUTPUT_LIMIT');
});

test('total edge budget rejects highly fragmented masks with OUTPUT_LIMIT before output allocation', () => {
  const widthPx = 512; const heightPx = 512;
  const mask = raster(widthPx, heightPx, (x, y) => (x + y) % 2 === 0);
  throwsCode(() => traceContours(mask, { widthPx, heightPx }), 'OUTPUT_LIMIT');
});

test('all nonempty 3x3 masks conserve pixel area and centroid under 4-neighbour tracing', () => {
  for (let bits = 1; bits < 512; bits++) {
    const mask = Uint8Array.from({ length: 9 }, (_, index) => bits & (1 << index) ? 255 : 0);
    const result = traceContours(mask, { widthPx: 3, heightPx: 3 });
    let area = 0; let sumX = 0; let sumY = 0; let components = 0; const seen = new Set();
    for (let index = 0; index < 9; index++) if (mask[index]) {
      area++; sumX += index % 3 + 0.5; sumY += Math.floor(index / 3) + 0.5;
      if (seen.has(index)) continue;
      components++; const stack = [index]; seen.add(index);
      while (stack.length) {
        const cell = stack.pop(); const x = cell % 3; const y = Math.floor(cell / 3);
        for (const [nx, ny] of [[x - 1, y], [x + 1, y], [x, y - 1], [x, y + 1]]) if (nx >= 0 && nx < 3 && ny >= 0 && ny < 3) {
          const next = ny * 3 + nx;
          if (mask[next] && !seen.has(next)) { seen.add(next); stack.push(next); }
        }
      }
    }
    assert.equal(result.contours.filter(contour => !contour.isHole).length, components, `4-connected components for mask ${bits}`);
    assert.equal(result.contours.reduce((sum, contour) => sum + contour.signedAreaPx, 0), area, `area for mask ${bits}`);
    const checks = byId(checkBasicGeometry({ contours: result }));
    near(checks.areaRatio.observed, area / 9);
    near(checks.centroidPx.observed[0], sumX / area);
    near(checks.centroidPx.observed[1], sumY / area);
    for (const contour of result.contours) {
      assert.deepEqual(contour.points.at(-1), contour.points[0]);
      for (let index = 1; index < contour.points.length; index++) assert.equal(Math.abs(contour.points[index][0] - contour.points[index - 1][0]) + Math.abs(contour.points[index][1] - contour.points[index - 1][1]), 1);
    }
  }
});

test('sparse numeric inputs are rejected while a large finite color tolerance selects all colors', () => {
  const rgba = Uint8Array.of(255, 255, 255, 255);
  throwsCode(() => extractMask(rgba, { widthPx: 1, heightPx: 1, predicate: { type: 'colorDistance', color: Array(3), tolerance: 1 } }), 'INVALID_PREDICATE');
  throwsCode(() => bboxOfContour([Array(2)]), 'INVALID_CONTOUR');
  throwsCode(() => checkBasicGeometry({ contours: rectangle(), expect: { centroidPx: Array(2) } }), 'INVALID_EXPECTATION');
  assert.equal(extractMask(rgba, { widthPx: 1, heightPx: 1, predicate: { type: 'colorDistance', color: [0, 0, 0], tolerance: 1000 } }).coverageRatio, 1);
});
