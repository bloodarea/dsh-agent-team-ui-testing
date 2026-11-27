import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { createRoiMapping, mapPointToSource, mapPointFromSource, mapRectToSource } from '../../targets/three-d/spec/reference.js';

// Independent synthetic oracle: source pixel IDs and exact BigInt fractions.
// Expected coordinates never come from a production matrix or its inverse.
// This measures CPU coordinate geometry, NOT an independently calibrated image
// resampler, Blender capture, display, or externally annotated reference image.
const q = (n, d = 1) => ({ n: BigInt(n), d: BigInt(d) });
const add = (a, b) => q(a.n * b.d + b.n * a.d, a.d * b.d);
const sub = (a, b) => q(a.n * b.d - b.n * a.d, a.d * b.d);
const mul = (a, b) => q(a.n * b.n, a.d * b.d);
const num = a => Number(a.n) / Number(a.d);
const floor = a => Number(a.n >= 0n ? a.n / a.d : (a.n - a.d + 1n) / a.d);
const ceil = a => -floor(q(-a.n, a.d));
const xy = point => point.map(num);
const SCALES = [q(1, 2), q(1), q(2)];
const ORIGINS = [[q(0), q(0)], [q(13, 10), q(7, 10)], [q(1021, 10), q(537, 10)]];
const SOURCE = { widthPx: 1001, heightPx: 801, rectPx: [199, 101, 401, 301] };
const THRESHOLD = 0.5;
const artifact = new URL('./runs/blender-reference-accuracy.json', import.meta.url);

// A coordinate-labelled source raster; each pixel stores its one-based source
// pixel ID. Reading the source image supplies truth before any mapper is called.
const pixels = new Uint32Array(SOURCE.widthPx * SOURCE.heightPx);
for (let index = 0; index < pixels.length; index++) pixels[index] = index + 1;
function sourcePixelCenter(x, y) {
  const index = pixels[y * SOURCE.widthPx + x] - 1;
  return [q(2 * (index % SOURCE.widthPx) + 1, 2), q(2 * Math.floor(index / SOURCE.widthPx) + 1, 2)];
}
function derivedFixture(sourcePoint, scale, origin) {
  // Exact scalar fixture construction, independent of both production mappings.
  return sourcePoint.map((value, axis) => add(origin[axis], mul(sub(value, q(SOURCE.rectPx[axis])), scale)));
}
function mappingFixture(scale, origin) {
  const contentRect = [...xy(origin), num(mul(q(401), scale)), num(mul(q(301), scale))];
  const config = { ...SOURCE, outputWidth: Math.ceil(contentRect[0] + contentRect[2] + 3), outputHeight: Math.ceil(contentRect[1] + contentRect[3] + 3), contentRect };
  return { config, mapping: createRoiMapping(config) };
}
function pointFixtures() {
  const points = [];
  // All four corner pixel centres plus a fixed 17x19 lattice (no random seed or
  // threshold-based selection). Non-integer source coordinates are preserved.
  for (let row = 0; row < 19; row++) for (let column = 0; column < 17; column++) {
    points.push({ id: `pixel-${column}-${row}`, source: sourcePixelCenter(199 + Math.floor(column * 400 / 16), 101 + Math.floor(row * 300 / 18)) });
  }
  for (const [x, y] of [[q(1, 1000), q(1, 1000)], [q(400999, 1000), q(1, 1000)], [q(1, 1000), q(300999, 1000)], [q(400999, 1000), q(300999, 1000)]]) {
    points.push({ id: `inside-corner-${points.length - 323}`, source: [add(q(199), x), add(q(101), y)] });
  }
  points.push({ id: 'exact-top-left-boundary', source: [q(199), q(101)] });
  return points;
}
function stats(samples) {
  if (!samples.length) return { maxErr: null, p95Err: null, meanErr: null };
  const errors = samples.map(sample => sample.errPx).sort((a, b) => a - b);
  return { maxErr: errors.at(-1), p95Err: errors[Math.ceil(errors.length * 0.95) - 1], meanErr: errors.reduce((sum, error) => sum + error, 0) / errors.length };
}
function measurement(expected, observed, extra = {}, sourcePixelsPerUnit = 1) {
  const delta = observed.map((value, axis) => Math.abs(value - expected[axis]) * sourcePixelsPerUnit);
  return { ...extra, expected, observed, errPx: Math.hypot(...delta), maxAxisErrPx: Math.max(...delta) };
}
function group(scale, strategy, samples, extra = {}) {
  const result = { scale: num(scale), strategy, points: samples.length, ...stats(samples), ...extra };
  result.verdict = samples.length ? result.maxErr < THRESHOLD ? 'pass' : 'fail' : 'unknown';
  result.maxAxisErr = samples.length ? Math.max(...samples.map(sample => sample.maxAxisErrPx)) : null;
  result.worstSamples = [...samples].sort((a, b) => b.errPx - a.errPx).slice(0, 3);
  return result;
}
function corners([left, top, right, bottom]) {
  return [[left, top], [right, top], [left, bottom], [right, bottom]];
}
function boundsOfRect([x, y, width, height]) { return [x, y, x + width, y + height]; }
function quantizedBounds(bounds, strategy) {
  return bounds.map((value, axis) => (strategy === 'outward' ? axis < 2 ? floor : ceil : axis < 2 ? ceil : floor)(value));
}
function rectFixtures() {
  // Include zero, near-one and exactly-half phases, independently on both axes.
  // Base extents are odd (79x61), with fractional edge phases added; all
  // rectangles are positive and strictly internal to the odd-sized source ROI.
  const phases = [0, 1, 125, 250, 500, 875, 999];
  return phases.flatMap(px => phases.map(py => ({
    id: `rect-phase-${px}-${py}`,
    bounds: [add(q(219), q(px, 1000)), add(q(121), q(py, 1000)), add(q(298), q(py, 1000)), add(q(182), q(px, 1000))],
  })));
}

const groups = [];
const boundaryChecks = [];
for (const scale of SCALES) {
  const continuous = [];
  const rectangleSamples = { outward: [], inward: [] };
  const oracleMismatches = { outward: [], inward: [] };
  const configs = [];
  for (const origin of ORIGINS) {
    const { mapping, config } = mappingFixture(scale, origin); configs.push(config);
    for (const point of pointFixtures()) {
      const expectedSource = xy(point.source);
      const expectedDerived = xy(derivedFixture(point.source, scale, origin));
      continuous.push(measurement(expectedSource, mapPointToSource(mapping, expectedDerived), { id: point.id, origin: xy(origin), direction: 'to-source' }));
      continuous.push(measurement(expectedDerived, mapPointFromSource(mapping, expectedSource), { id: point.id, origin: xy(origin), direction: 'from-source' }, 1 / num(scale)));
    }
    // Half-open exact right/bottom corners must be rejected, not silently
    // substituted with a nearby sample or counted as a zero-error observation.
    const c = mapping.contentRect;
    for (const point of [[c[0] + c[2], c[1]], [c[0], c[1] + c[3]], [c[0] + c[2], c[1] + c[3]]]) {
      let code = null;
      try { mapPointToSource(mapping, point); } catch (error) { code = error.code; }
      boundaryChecks.push({ scale: num(scale), origin: xy(origin), point, expected: 'PADDING_POINT', observed: code });
    }
    const fullRect = mapRectToSource(mapping, c);
    boundaryChecks.push({ scale: num(scale), origin: xy(origin), kind: 'full-ROI-all-four-boundaries', expected: SOURCE.rectPx, observed: fullRect });
    for (const fixture of rectFixtures()) {
      const sourceCorners = corners(fixture.bounds).map(xy);
      const derivedCorners = corners(fixture.bounds).map(point => xy(derivedFixture(point, scale, origin)));
      const [tl, , , br] = derivedCorners;
      const derivedRect = [tl[0], tl[1], br[0] - tl[0], br[1] - tl[1]];
      const outward = boundsOfRect(mapRectToSource(mapping, derivedRect));
      // Inward is a TEST-ONLY composition of the supported point mapper. There
      // is no native inward rectangle API; this is not reported as one.
      const innerTL = mapPointToSource(mapping, tl); const innerBR = mapPointToSource(mapping, br);
      const inward = [Math.ceil(innerTL[0]), Math.ceil(innerTL[1]), Math.floor(innerBR[0]), Math.floor(innerBR[1])];
      for (const strategy of ['outward', 'inward']) {
        const observed = strategy === 'outward' ? outward : inward;
        const expectedInteger = quantizedBounds(fixture.bounds, strategy);
        if (observed.some((value, index) => value !== expectedInteger[index])) oracleMismatches[strategy].push({ id: fixture.id, origin: xy(origin), expected: expectedInteger, observed });
        corners(observed).forEach((point, index) => rectangleSamples[strategy].push(measurement(sourceCorners[index], point, { id: fixture.id, corner: index, origin: xy(origin) })));
      }
    }
  }
  groups.push(group(scale, 'continuous-points-both-directions', continuous, { implementation: 'production point APIs; each direction checked independently', configs }));
  for (const strategy of ['outward', 'inward']) groups.push(group(scale, `${strategy}-integer-rectangle`, rectangleSamples[strategy], {
    implementation: strategy === 'outward' ? 'production mapRectToSource' : 'test-only point-map + ceil/floor composition; native API unavailable',
    errorIncludes: 'integer quantization relative to unrounded independent source truth',
    oracleMismatchCount: oracleMismatches[strategy].length,
    oracleMismatches: oracleMismatches[strategy].slice(0, 5),
  }));
  for (const strategy of ['fractional-source-ROI', 'native-inward-rectangle']) {
    let code = null;
    if (strategy === 'fractional-source-ROI') {
      try { createRoiMapping({ ...SOURCE, rectPx: [199.25, 101.75, 401, 301], outputWidth: Math.ceil(401 * num(scale)), outputHeight: Math.ceil(301 * num(scale)) }); } catch (error) { code = error.code; }
    }
    groups.push(group(scale, strategy, [], { reason: strategy === 'fractional-source-ROI' ? 'createRoiMapping rejects non-integer rectPx; no observed coordinates, no error can be measured.' : 'mapRectToSource has no inward policy parameter; composed test-only measurements are listed separately.', observedCode: code }));
  }
}
const report = {
  schemaVersion: 1,
  taskId: 'A2-06-SUBPIXEL',
  command: 'node --test tests/acceptance/blender-reference-accuracy.mjs',
  runtime: { node: process.version, platform: process.platform },
  unit: 'source-image px',
  metric: 'Euclidean point/corner distance; from-source residuals converted back to source pixels',
  percentile: 'nearest rank: sortedErrors[ceil(N * 0.95) - 1]',
  threshold: { maxErrExclusive: THRESHOLD },
  scope: 'CPU coordinate mapping only; no Blender process, raster resampling or external calibration is measured',
  groundTruth: {
    synthetic: { status: 'available', source: 'coordinate-labelled source Uint32 raster, fixed rational fixture geometry and independent BigInt arithmetic', independence: 'Expected coordinates are fixed before invoking the mapper. No production matrix, inverse, round trip, PNG encoder or decoder is used to obtain truth.' },
    external: { status: 'unknown', reason: 'No independently calibrated source/derived image pairs, external landmark annotations, or actual crop/resample pipeline are provided. Synthetic geometry cannot establish external image accuracy.' },
  },
  coverage: { source: SOURCE, scales: SCALES.map(num), contentOrigins: ORIGINS.map(xy), pixelGrid: [17, 19], cornerPixelCenters: 'all four', insideBoundaryInsetPx: 0.001, exactRightBottomPointConvention: 'half-open rejection', rectanglePhasesPx: [0, 0.001, 0.125, 0.25, 0.5, 0.875, 0.999] },
  verdict: groups.some(result => result.verdict === 'fail') ? 'fail' : groups.some(result => result.verdict === 'unknown') ? 'unknown' : 'pass',
  groups,
  boundaryChecks,
};
// Persist even when a subsequent accuracy assertion fails. A report-level fail
// remains fail even when the test correctly detects an expected precision limit.
await mkdir(new URL('./runs/', import.meta.url), { recursive: true });
await writeFile(artifact, `${JSON.stringify(report, null, 2)}\n`);
console.log('ROI accuracy: source pixels; max / p95 / mean (strict max < 0.5)');
for (const result of groups) console.log(`scale=${result.scale} ${result.strategy} points=${result.points} max=${result.maxErr} p95=${result.p95Err} mean=${result.meanErr} verdict=${result.verdict}`);
console.log(`External ground truth: ${report.groundTruth.external.status}; overall measurement verdict=${report.verdict}`);

// Literal anchor pairs guard the independently constructed fixture itself.
test('independent rational fixture agrees with fixed source/derived anchor pairs', () => {
  const origin = [q(13, 10), q(7, 10)];
  const center = [q(399, 2), q(203, 2)];
  const farCenter = [q(1199, 2), q(803, 2)];
  for (const [scale, nearExpected, farExpected] of [[q(1, 2), [1.55, 0.95], [201.55, 150.95]], [q(1), [1.8, 1.2], [401.8, 301.2]], [q(2), [2.3, 1.7], [802.3, 601.7]]]) {
    assert.deepEqual(xy(derivedFixture(center, scale, origin)), nearExpected);
    assert.deepEqual(xy(derivedFixture(farCenter, scale, origin)), farExpected);
  }
  assert.deepEqual(quantizedBounds([q(219125, 1000), q(121875, 1000), q(298875, 1000), q(182125, 1000)], 'outward'), [219, 121, 299, 183]);
  assert.deepEqual(quantizedBounds([q(219125, 1000), q(121875, 1000), q(298875, 1000), q(182125, 1000)], 'inward'), [220, 122, 298, 182]);
});
for (const scale of SCALES) {
  const measured = groups.filter(result => result.scale === num(scale));
  test(`continuous independent point errors stay <0.5 source px at scale ${num(scale)}`, () => {
    const result = measured.find(result => result.strategy === 'continuous-points-both-directions');
    assert.equal(result.points, 328 * 2 * ORIGINS.length);
    assert.ok(result.maxErr < THRESHOLD, JSON.stringify(result));
  });
  for (const strategy of ['outward', 'inward']) test(`${strategy} integer rectangles honestly exceed subpixel threshold at scale ${num(scale)}`, () => {
    const result = measured.find(result => result.strategy === `${strategy}-integer-rectangle`);
    assert.equal(result.points, 49 * 4 * ORIGINS.length);
    assert.equal(result.verdict, 'fail', 'Deliberate integer quantization is not a subpixel accuracy pass.');
    assert.ok(result.maxErr >= THRESHOLD);
    assert.equal(result.oracleMismatchCount, 0, JSON.stringify(result.oracleMismatches));
  });
  test(`unsupported fractional source ROI/native inward API stay unknown at scale ${num(scale)}`, () => {
    const unsupported = measured.filter(result => result.verdict === 'unknown');
    assert.equal(unsupported.length, 2);
    assert.equal(unsupported.find(result => result.strategy === 'fractional-source-ROI').observedCode, 'INVALID_ROI');
    for (const result of unsupported) assert.deepEqual([result.points, result.maxErr, result.p95Err, result.meanErr], [0, null, null, null]);
  });
}
test('exact excluded corners reject and full rectangles retain all four ROI boundaries', () => {
  assert.equal(boundaryChecks.length, SCALES.length * ORIGINS.length * 4);
  for (const check of boundaryChecks) assert.deepEqual(check.observed, check.expected, JSON.stringify(check));
});
test('written artifact preserves failures, numeric measurements and external unknown', async () => {
  const saved = JSON.parse(await readFile(artifact, 'utf8'));
  assert.equal(saved.verdict, 'fail');
  assert.equal(saved.groundTruth.external.status, 'unknown');
  assert.equal(saved.groups.length, 15);
  assert.equal(saved.groups.filter(result => result.verdict === 'fail').length, 6);
  assert.equal(saved.groups.filter(result => result.verdict === 'unknown').length, 6);
  for (const result of saved.groups.filter(result => result.points)) {
    assert.ok([result.maxErr, result.p95Err, result.meanErr].every(Number.isFinite));
    assert.ok(result.meanErr <= result.maxErr && result.p95Err <= result.maxErr);
  }
});
