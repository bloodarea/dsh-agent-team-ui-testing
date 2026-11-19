/**
 * Web environment tool surface: the 43 execution tools plus the discovery entry, with their
 * schemas and handlers.
 *
 * This is Web code: every handler drives a Chromium page through the runtime and the P0 data
 * plane, and none of it is meaningful for another platform. The Host does not know these schemas —
 * it receives the definitions, decides admission (environment + capability + provider gate), wraps
 * each with its per-Agent `when` predicate and registers it.
 *
 * Dependency direction: `core/` and the Web runtime module only. Everything the surface needs from
 * the Host arrives as an explicit seam in `createWebToolSurface()` (log, the composition root's
 * P0/dispatch entry, disclosure, the page registry, the attachment service and the capture staging
 * root). The surface never reads a Cordis context or a Host route.
 */
import { createHash } from 'node:crypto';
import { realpathSync, statSync } from 'node:fs';
import http from 'node:http';
import https from 'node:https';
import { join } from 'node:path';

import { abortable, BrowserError, redactText, redactUrl } from '../../browser-safety.js';
import {
  AGENT_HOLD_MS, ANNOTATION_AGENT_ACTIONS, ANNOTATION_AGENT_DEFAULT_STROKE, ANNOTATION_AGENT_MAX_SHAPES_PER_CALL, ANNOTATION_ERASE_DEFAULT_RADIUS, ANNOTATION_FOREGROUND_TTL_MS,
  ANNOTATION_LIMITS, ANNOTATION_SPACE, ANNOTATION_TYPES, ANNOTATION_VERSION, CAPTURE_LIMITS, CAPTURE_PERSIST_RULES,
  CAPTURE_WARNING_VOCABULARY, CLOSED_HISTORY_LIMIT, DYNAMIC_ASSERTION_TYPES, DYNAMIC_BASES, DYNAMIC_DIRECTIONS, DYNAMIC_INTERNAL,
  DYNAMIC_LIMITS, DYNAMIC_MILESTONE, DYNAMIC_REGISTERED_TOOLS, DYNAMIC_SOURCES, DYNAMIC_TOOL_NAMES, HTTP_DEFAULTS,
  HTTP_LIMITS, IDLE_MS_DEFAULT, IMAGE_INLINE_BASE64_LIMIT, MAX_PAGES_DEFAULT, MODIFIER_BITS, NETWORK_LIMIT,
  NETWORK_SUBTARGETS, POPUP_NOTICES_LIMIT, Runtime, T2_FORM_KINDS, T2_LIMITS, T4_LIMITS,
  VIEW_LIMITS, VIEW_PRESETS, addCaptureWarning, annotationLimits, assertCaptureBudget, captureEnvRoot,
  captureRootFor, checkPixelSize, createBaselineStore, createCaptureMapping, decodePng, delay,
  detectImageAnomaly, dynamicCapabilityConstraints, dynamicJsonProjection, expandViewPatch, expectedPixelSize, inlineImageDelivery,
  inspectPng, network, normalizeAgentAnnotationCall, normalizeCaptureRequest, normalizeModifiers, normalizeViewportRequest,
  projectAttachment, projectCaptureMapping, publishCapture, resolveCapturePath, t2BooleanField, t2IntegerField,
  t2ModifierList, t2NumberField, t2Object, t2RejectUnknown, t2StringField, vision,
} from './host.js';

export function createWebToolSurface({
  log = () => {},
  crossEnvironment,
  disclosure,
  registry = null,
  origins = new Set(),
  httpClient = null,
  text,
  p0,
  ensureCaptureStagingRoot,
  // The Host's discovery entry name: the surface answers "which groups are active" against it.
  DISCOVERY_TOOL = 'browser_tools',
} = {}) {
  /** Attachment service, injected by the Host; absence degrades to inline base64. */
  let attachments = null;
  /** Collected definitions in registration order. */
  const definitions = [];
  /**
   * Registration sink of the environment.
   *
   * The Host owns admission, disclosure and the actual `ctx.tools.register`; here a definition is
   * only collected, so the same surface can be mounted by a test harness without a host registry.
   */
  const register = (definition) => {
    definitions.push(definition);
    return null;
  };

  function liveReadinessTarget(exec, runtime) {
    const rt = runtime || exec?.runtime || null;
    if (!rt || typeof rt !== 'object') return null;
    // A created-but-idle runtime entry is not a bound target: only a running page (or a live CDP
    // transport) proves the connection/target axes. Otherwise the probe's not-probed/unbound stay.
    const live = rt.running === true || Boolean(rt.cdp && rt.cdp.closed !== true);
    if (!live) return null;
    const runtimeId = rt.runtimeId || rt.id || null;
    if (!runtimeId) return null;
    return {
      sessionId: exec?.agent?.id ? String(exec.agent.id) : null,
      runtimeId: String(runtimeId),
      url: typeof rt.url === 'string' ? redactUrl(rt.url) : null,
      transport: rt.transport || (rt.send ? 'ws' : null),
      // The Runtime keeps the page/document generation as `generation`; both names are accepted so
      // the target axis can carry a real generation instead of a null placeholder.
      pageGeneration: Number.isInteger(rt.pageGeneration) ? rt.pageGeneration
        : (Number.isInteger(rt.generation) ? rt.generation : null),
      documentEpoch: Number.isInteger(rt.documentEpoch) ? rt.documentEpoch : null,
    };
  }
  const T3_EVIDENCE_BYTES = 262144;
  const T3_EVIDENCE_REGIONS = 100;
  const T3_MAX_CASES = 20;
  const T3_MAX_ASSERTIONS = 32;
  const T3_MAX_FACTS = 64;
  const T3_MAX_MASKS = 64;
  const T3_MAX_ANNOTATIONS = 64;
  const T3_MAX_PREPROCESS = 8;
  const T3_ACT_MAX_AGE_MS = 30000;
  const T3_TOOL_NAMES = Object.freeze([
    'browser_vision_image', 'browser_vision_find', 'browser_vision_compare',
    'browser_vision_act', 'browser_vision_baseline', 'browser_vision_check',
  ]);
  const T3_SOURCE_KINDS = Object.freeze(['live', 'product', 'baseline']);
  const T3_WARNING_VOCABULARY = Object.freeze([
    ...(Array.isArray(vision.WARNING_VOCABULARY) ? vision.WARNING_VOCABULARY : []),
  ]);
  const T3_FACT_SOURCES = Object.freeze([
    'browser_snapshot', 'browser_node_state', 'browser_computed_style', 'browser_eval',
  ]);
  const T3_ASSERTION_TYPES = Object.freeze([
    'regression', 'layout', 'occlusion', 'overflow', 'truncation', 'color', 'missing',
  ]);
  const T3_OVERFLOW_VALUES = Object.freeze(['visible', 'hidden', 'clip', 'auto', 'scroll']);
  const T3_WHITE_SPACE_VALUES = Object.freeze(['normal', 'nowrap', 'pre', 'pre-wrap', 'pre-line', 'break-spaces']);
  const T3_TEXT_OVERFLOW_VALUES = Object.freeze(['clip', 'ellipsis']);
  const T3_ALGORITHM_VERSION = (() => {
    const value = vision.VISION_ALGORITHM_VERSION;
    return typeof value === 'string' && value ? value : 't3-v1';
  })();
  const T3_LIMITS = (() => {
    const source = vision.VISION_LIMITS && typeof vision.VISION_LIMITS === 'object' ? vision.VISION_LIMITS : {};
    return {
      maxProducts: Number.isFinite(source.maxProducts) ? source.maxProducts : 16,
      maxTotalBytes: Number.isFinite(source.maxTotalBytes) ? source.maxTotalBytes : 128 * 1024 * 1024,
      maxProductBytes: Number.isFinite(source.maxProductBytes) ? source.maxProductBytes : 32 * 1024 * 1024,
      maxProductPixels: Number.isFinite(source.maxProductPixels) ? source.maxProductPixels : 16000000,
      maxWorkingSetBytes: Number.isFinite(source.maxWorkingSetBytes) ? source.maxWorkingSetBytes : 256 * 1024 * 1024,
      maxTemplateComparisons: Number.isFinite(source.maxTemplateComparisons) ? source.maxTemplateComparisons : 50000000,
      algorithmBudgetMs: Number.isFinite(source.algorithmBudgetMs) ? source.algorithmBudgetMs : 5000,
      maxOutputPixels: Number.isFinite(source.maxOutputPixels) ? source.maxOutputPixels : 16000000,
      maxOutputBytes: Number.isFinite(source.maxOutputBytes) ? source.maxOutputBytes : 32 * 1024 * 1024,
    };
  })();
  const T3_DEFAULT_DIFF_OPTIONS = Object.freeze({ threshold: 0.1, includeAA: false, minRegionPixels: 1 });
  const T3_DEFAULT_THRESHOLDS = Object.freeze({ warnRatio: 0.001, failRatio: 0.01 });
  const t3Warning = (warnings, code) => {
    if (typeof code === 'string' && code !== '' && !warnings.includes(code)) warnings.push(code);
  };
  const t3Sha256 = (data) => createHash('sha256').update(data).digest('hex');
  const t3RgbaSha256 = (rgba) => createHash('sha256')
    .update(Buffer.from(rgba.buffer, rgba.byteOffset, rgba.byteLength)).digest('hex');
  const t3NewBudget = () => ({ startedAt: Date.now(), budgetMs: T3_LIMITS.algorithmBudgetMs });
  const t3AlgoOpts = (budget, signal) => ({
    signal,
    budgetMs: budget && Number.isFinite(budget.budgetMs) ? budget.budgetMs : T3_LIMITS.algorithmBudgetMs,
    startedAt: budget && Number.isFinite(budget.startedAt) ? budget.startedAt : Date.now(),
  });
  const t3Invalid = (message, details = {}) => new BrowserError('INVALID_ARGUMENT', message, details);

  /** Decode helper: the module reports failures as `{ok:false,code,message}` (never throws). */
  async function t3Decode(bytes, signal, budget) {
    let decoded;
    try {
      decoded = await vision.decodePngToRgbaAsync(bytes, t3AlgoOpts(budget, signal));
    } catch (error) {
      if (error instanceof BrowserError) throw error;
      throw new BrowserError('INVALID_PNG', '图像解码失败', { reason: redactText(String(error && error.message ? error.message : error)).slice(0, 200) });
    }
    if (!decoded || decoded.ok !== true) {
      throw new BrowserError(decoded && decoded.code ? decoded.code : 'INVALID_PNG',
        decoded && decoded.message ? decoded.message : '图像解码失败',
        decoded && decoded.details ? decoded.details : {});
    }
    if (!Number.isInteger(decoded.width) || !Number.isInteger(decoded.height) || !decoded.rgba) {
      throw new BrowserError('INTERNAL', '解码结果缺少尺寸或 RGBA 缓冲');
    }
    return decoded;
  }

  /**
   * Contract Mapping for a live capture (§3.1).
   *
   * `p = scale × runtimeDSF` (DSF pinned to 1) is the nominal density, but Chromium *floors* a
   * fractional clip: a 79.5×59.5 CSS clip at scale 1 comes back as 79×59 pixels. The contract says
   * the mapping must report the actual sampling, so cssPerPixel is derived from the requested CSS
   * rect and the real PNG size (axis-independent) instead of the nominal p.
   */
  function t3CaptureMapping(captured, width, height) {
    const requestedWidth = Number.isFinite(captured.region.width) && captured.region.width > 0 ? captured.region.width : width;
    const requestedHeight = Number.isFinite(captured.region.height) && captured.region.height > 0 ? captured.region.height : height;
    // Canvas == document coordinates (content is anchored at (0,0)); what changes is the framing.
    // O ≠ 0 is a composited canvas capture and its mapping must say canvas-css-px so an old
    // document baseline is rejected as mapping-incompatible instead of being silently misread
    // (docs/viewport-control.md).
    const canvas = captured.canvas && typeof captured.canvas === 'object' ? captured.canvas : null;
    const canvasSpace = Boolean(canvas && canvas.composite);
    const mapping = {
      coordinateSpace: canvasSpace ? 'canvas-css-px' : 'document-css-px',
      originCss: { x: captured.region.x, y: captured.region.y },
      cssPerPixel: { x: requestedWidth / width, y: requestedHeight / height },
      imagePixels: { width, height },
      capturedCssRect: {
        x: captured.region.x, y: captured.region.y,
        width: captured.region.width, height: captured.region.height,
      },
      scrollAtCapture: { x: captured.scroll.x, y: captured.scroll.y },
      viewportAtCapture: { width: captured.viewport.width, height: captured.viewport.height },
      visualViewportScale: Number.isFinite(captured.visualViewportScale) ? captured.visualViewportScale : null,
      geometryTransform: 'axis-aligned',
    };
    if (canvas) {
      mapping.canvas = {
        x: canvas.x, y: canvas.y,
        scrollX: canvas.scrollX, scrollY: canvas.scrollY,
        offsetX: canvas.offsetX, offsetY: canvas.offsetY,
        contentWidth: canvas.contentWidth, contentHeight: canvas.contentHeight,
      };
    }
    if (captured.contentRect) mapping.contentRect = { ...captured.contentRect };
    mapping.blank = 'outside-content';
    return mapping;
  }

  /** Public Product projection (contract §2.2). Never contains bytes/base64. */
  function t3ProductPublic(entry) {
    if (!entry || typeof entry !== 'object') return null;
    const byteLength = Buffer.isBuffer(entry.bytes) || entry.bytes instanceof Uint8Array
      ? entry.bytes.length
      : Number.isFinite(entry.bytes) ? entry.bytes : null;
    return {
      productId: entry.productId,
      width: Number.isInteger(entry.width) ? entry.width : null,
      height: Number.isInteger(entry.height) ? entry.height : null,
      bytes: byteLength,
      sha256: typeof entry.sha256 === 'string' ? entry.sha256 : null,
      rgbaSha256: typeof entry.rgbaSha256 === 'string' ? entry.rgbaSha256 : null,
      createdAt: Number.isFinite(entry.createdAt) ? entry.createdAt : null,
      capturedAt: Number.isFinite(entry.capturedAt) ? entry.capturedAt : null,
      kind: typeof entry.kind === 'string' ? entry.kind : null,
      mapping: entry.mapping && typeof entry.mapping === 'object' ? entry.mapping : null,
      actionable: entry.actionable === true,
      parentIds: Array.isArray(entry.parentIds) ? [...entry.parentIds] : [],
      operations: Array.isArray(entry.operations)
        ? entry.operations.map((item) => ({ op: item && item.op ? item.op : null, parameters: item && item.parameters ? item.parameters : {} }))
        : [],
    };
  }

  /** Store one product and remember its provenance (act/evidence need it after pin()). */
  function t3AddProduct(runtime, entry) {
    const product = runtime.visionProducts.add({
      bytes: entry.bytes,
      width: entry.width,
      height: entry.height,
      sha256: entry.sha256,
      rgbaSha256: entry.rgbaSha256 ?? null,
      kind: entry.kind,
      mapping: entry.mapping ?? null,
      actionable: entry.actionable === true,
      parentIds: entry.parentIds ?? [],
      operations: entry.operations ?? [],
      createdAt: Date.now(),
      capturedAt: entry.capturedAt ?? null,
    });
    if (!product || typeof product.productId !== 'string') {
      throw new BrowserError('INTERNAL', 'product store 未返回 productId');
    }
    runtime.visionProvenance.set(product.productId, entry.provenance ?? null);
    return product;
  }
  function t3Provenance(runtime, exec) {
    return {
      actionId: exec && exec.meta ? exec.meta.actionId ?? null : null,
      scopeId: runtime.scope ? runtime.scope.id : null,
      runtimeId: runtime.runtimeId ?? null,
      pageGeneration: runtime.pageGeneration(),
      documentEpoch: runtime.documentEpoch(),
    };
  }

  /** Release every product pinned by one tool call (never throws). */
  function t3ReleasePins(runtime, pins) {
    for (const productId of pins) {
      try { runtime.visionProducts.release(productId); } catch { /* ignore */ }
    }
    pins.length = 0;
  }

  /**
   * Re-normalise an already validated Source. The module rejects an explicit `region: null`, so a
   * normalised live source must be rebuilt with the absent field omitted (idempotent otherwise).
   */
  function t3SourceForResolve(source, label) {
    if (!source || typeof source !== 'object' || typeof source.kind !== 'string') {
      return vision.validateSource(source, label);
    }
    if (source.kind === 'live') {
      // `scale` is forwarded only when the caller actually gave one: the validator keeps the
      // "omitted" state so the Host can resolve the shared view.scale inside this call
      // (docs/viewport-control.md). Defaulting to 1 here would freeze the old behaviour.
      return vision.validateSource({
        kind: 'live',
        ...(source.scale !== undefined ? { scale: source.scale } : {}),
        ...(source.region ? { region: source.region } : {}),
      }, label);
    }
    if (source.kind === 'product') return vision.validateSource({ kind: 'product', productId: source.productId }, label);
    return vision.validateSource({
      kind: 'baseline',
      name: source.name,
      ...(source.revision ? { revision: source.revision } : {}),
    }, label);
  }

  /**
   * Resolve one `Source` (contract §1.1) into bytes + decoded image + evidence source entry.
   * `role` is only used for evidence; every pin is released by the caller in `finally`.
   * The returned `captureFacts` is the ancestor capture lineage (act re-capture/age checks).
   */
  async function t3ResolveSource(runtime, exec, source, role, pins, budget, liveScale = null) {
    const normalized = t3SourceForResolve(source, 'source');
    if (normalized.kind === 'live') {
      // §3.1: a live CssRect must be inside the live cssContentSize; reject BEFORE the capture.
      // In canvas space (O ≠ 0) the region is a canvas rect and may be negative / outside content:
      // the blank part is composed as white and stays visible to find/compare (§6.2).
      const metrics = await runtime.layoutMetrics(exec.signal);
      const canvasSpace = runtime.canvasSpaceActive();
      if (normalized.region) {
        const r = normalized.region;
        if (!(r.width >= 1 && r.height >= 1)) {
          throw t3Invalid('source.region 非法', { path: 'source.region', reason: 'region-invalid' });
        }
        if (!canvasSpace) {
          if (!(r.x >= 0 && r.y >= 0)) {
            throw t3Invalid('source.region 非法', { path: 'source.region', reason: 'region-invalid' });
          }
          if (Number.isFinite(metrics.contentSize.width) && r.x + r.width > metrics.contentSize.width + 1e-9) {
            throw t3Invalid('source.region 超出文档宽度', { path: 'source.region', reason: 'region-outside-document' });
          }
          if (Number.isFinite(metrics.contentSize.height) && r.y + r.height > metrics.contentSize.height + 1e-9) {
            throw t3Invalid('source.region 超出文档高度', { path: 'source.region', reason: 'region-outside-document' });
          }
        }
      }
      // One frozen default per tool call: an omitted source.scale follows the shared view.scale
      // (the caller captured it once before resolving any source), an explicit one wins.
      const resolvedScale = normalized.scale !== undefined
        ? normalized.scale
        : (Number.isFinite(liveScale) ? liveScale : runtime.view.scale);
      const scaleSource = normalized.scale !== undefined ? 'explicit' : 'view';
      const shot = await p0(exec, 'A', 'capture', {
        scale: resolvedScale, region: normalized.region ?? undefined, scaleSource,
      });
      const png = inspectPng(shot.pngBytes, { checkCrc: true });
      if (!png.ok) {
        throw new BrowserError('INVALID_PNG', '实时采集返回的字节不是结构完整的 PNG（不交付坏图）', {
          phase: 'inspectPng', reason: png.message,
        });
      }
      const expected = expectedPixelSize({
        width: shot.capture.region.width,
        height: shot.capture.region.height,
        scale: shot.capture.requestedScale,
        deviceScaleFactor: shot.capture.deviceScaleFactor,
      });
      // Chromium floors a fractional clip (79.5 CSS @1 → 79 px). A ≤1 px difference per axis is that
      // rounding, not a size mismatch: accept the actual sampling and let the mapping report it
      // (§3.1). Anything larger is refused. `browser_screenshot` keeps its strict P0 behaviour.
      const sizeDelta = { x: Math.abs(png.width - expected.width), y: Math.abs(png.height - expected.height) };
      if (sizeDelta.x > 1 || sizeDelta.y > 1) {
        throw new BrowserError('CAPTURE_SIZE_MISMATCH', '实时采集尺寸与期望相差超过 1px（不交付图片）', {
          actual: { width: png.width, height: png.height },
          expected: { width: expected.width, height: expected.height },
          tolerance: 1,
        });
      }
      const sizeTolerance = {
        expected: { width: expected.width, height: expected.height },
        actual: { width: png.width, height: png.height },
        maxDeltaPx: 1,
        delta: sizeDelta,
      };
      const decoded = await t3Decode(shot.pngBytes, exec.signal, budget);
      const mapping = t3CaptureMapping(shot.capture, decoded.width, decoded.height);
      const sha256 = t3Sha256(shot.pngBytes);
      const capture = {
        version: 1,
        format: 'png',
        transport: 'cdp-page-capture-screenshot',
        request: {
          scale: shot.capture.requestedScale,
          scaleSource: shot.capture.scaleSource ?? scaleSource,
          viewRevision: Number.isFinite(shot.capture.viewRevision) ? shot.capture.viewRevision : null,
          region: normalized.region ? { ...normalized.region } : null,
          // The live source is a canvas rect once O ≠ 0 (docs/viewport-control.md); O = 0 keeps
          // the historical document coordinate space.
          space: 'canvas-css-px',
          coordinateSpace: mapping.coordinateSpace === 'canvas-css-px' ? 'canvas-css-px' : 'document-css-px',
          out: null,
          persist: false,
        },
        environment: {
          browser: 'chromium',
          headless: null,
          headlessSource: null,
          pageDevicePixelRatio: Number.isFinite(shot.capture.pageDevicePixelRatio) ? shot.capture.pageDevicePixelRatio : null,
          deviceScaleFactor: shot.capture.deviceScaleFactor,
          deviceScaleFactorSource: shot.capture.deviceScaleFactorSource,
          viewport: { width: shot.capture.viewport.width, height: shot.capture.viewport.height },
          scroll: { x: shot.capture.scroll.x, y: shot.capture.scroll.y },
        },
        png: { width: png.width, height: png.height, bytes: shot.pngBytes.length, chunks: png.chunks ?? null, crc: 'ok' },
        expected: { width: expected.width, height: expected.height, pixelsPerCssPixel: expected.pixelsPerCssPixel },
        sizeCheck: {
          ok: true,
          actual: { width: png.width, height: png.height },
          expected: { width: expected.width, height: expected.height },
          upscaled: false,
          tolerancePx: 1,
          delta: sizeDelta,
        },
        sizeTolerance,
        mapping,
        // Canvas provenance for this live source: composite is explicit, never implied.
        canvas: shot.capture.canvas ?? null,
        composite: shot.capture.composite === true,
        contentRect: shot.capture.contentRect ?? null,
        anomaly: { checked: false, uniform: null, transparent: null, sampledPixels: 0, distinctColors: null, averageColor: null, maxDelta: null, tolerance: 0 },
        file: null,
        delivery: {
          original: { width: png.width, height: png.height, bytes: shot.pngBytes.length, sha256, mediaType: 'image/png' },
          image: null,
          downscaled: false,
          reencoded: false,
        },
        warnings: [],
      };
      const captureFacts = {
        region: { ...shot.capture.region },
        scale: shot.capture.requestedScale,
        scroll: { x: shot.capture.scroll.x, y: shot.capture.scroll.y },
        viewport: { width: shot.capture.viewport.width, height: shot.capture.viewport.height },
        visualViewportScale: Number.isFinite(shot.capture.visualViewportScale) ? shot.capture.visualViewportScale : null,
        capturedAt: shot.capture.capturedAt,
        sha256,
        rgbaSha256: t3RgbaSha256(decoded.rgba),
        // Frozen at capture: act re-captures the same canvas rect and requires the same framing.
        canvas: shot.capture.canvas ?? null,
        contentRect: shot.capture.contentRect ?? null,
      };
      const product = t3AddProduct(runtime, {
        bytes: shot.pngBytes, width: decoded.width, height: decoded.height,
        sha256, rgbaSha256: captureFacts.rgbaSha256, kind: 'capture', mapping,
        actionable: true, parentIds: [], operations: [], capturedAt: shot.capture.capturedAt,
        provenance: { ...t3Provenance(runtime, exec), capture: captureFacts },
      });
      pins.push(product.productId);
      return {
        kind: 'live', role,
        product: t3ProductPublic(product),
        bytes: shot.pngBytes,
        sha256,
        image: { width: decoded.width, height: decoded.height, rgba: decoded.rgba },
        capture,
        captureFacts,
      };
    }
    if (normalized.kind === 'product') {
      const entry = runtime.visionProducts.pin(normalized.productId);
      if (!entry) {
        throw new BrowserError('VISION_SOURCE_NOT_FOUND', 'product 不存在、已淘汰或不属于本工作区', {
          productId: normalized.productId,
        });
      }
      pins.push(normalized.productId);
      const bytes = Buffer.isBuffer(entry.bytes) ? entry.bytes
        : entry.bytes instanceof Uint8Array ? Buffer.from(entry.bytes) : null;
      if (!bytes) throw new BrowserError('INTERNAL', 'product 条目缺少编码字节');
      const decoded = await t3Decode(bytes, exec.signal, budget);
      const stored = runtime.visionProvenance.get(normalized.productId) || null;
      return {
        kind: 'product', role,
        product: t3ProductPublic(entry),
        bytes,
        sha256: typeof entry.sha256 === 'string' ? entry.sha256 : t3Sha256(bytes),
        image: { width: decoded.width, height: decoded.height, rgba: decoded.rgba },
        capture: null,
        captureFacts: stored && stored.capture ? stored.capture : null,
      };
    }
    // baseline source: read-only, never creates the managed root/directories.
    const store = t3BaselineStore(runtime, exec);
    const got = await store.get(normalized.name, normalized.revision);
    if (!got || !got.meta || !got.pngBytes) {
      throw new BrowserError('VISION_BASELINE_NOT_FOUND', '基线不可读', { name: normalized.name, revision: normalized.revision ?? null });
    }
    const bytes = Buffer.isBuffer(got.pngBytes) ? got.pngBytes : Buffer.from(got.pngBytes);
    const decoded = await t3Decode(bytes, exec.signal, budget);
    const product = t3AddProduct(runtime, {
      bytes, width: decoded.width, height: decoded.height,
      sha256: t3Sha256(bytes), rgbaSha256: t3RgbaSha256(decoded.rgba), kind: 'baseline',
      mapping: got.meta.mapping ?? null, actionable: false, parentIds: [], operations: [],
      capturedAt: null, provenance: t3Provenance(runtime, exec),
    });
    pins.push(product.productId);
    return {
      kind: 'baseline', role,
      product: t3ProductPublic(product),
      bytes,
      sha256: t3Sha256(bytes),
      image: { width: decoded.width, height: decoded.height, rgba: decoded.rgba },
      capture: null,
      captureFacts: null,
      baseline: got.meta,
    };
  }

  /** Resolve the trusted persistent baseline root (P0 rules) and build the managed store. */
  function t3BaselineStore(runtime, exec) {
    const envRoot = captureEnvRoot();
    let root = null;
    let reason = null;
    if (envRoot !== null) {
      // A configured-but-invalid root never falls back to the workspace (contract §8.1).
      try {
        const info = statSync(envRoot);
        if (!info.isDirectory()) reason = 'env-root-not-directory';
        else root = realpathSync(envRoot);
      } catch {
        reason = 'env-root-unavailable';
      }
    } else {
      const resolved = captureRootFor(exec);
      if (resolved.root === null) reason = 'no-workspace-root';
      else {
        try {
          const info = statSync(resolved.root);
          if (!info.isDirectory()) reason = 'workspace-root-not-directory';
          else root = realpathSync(resolved.root);
        } catch {
          reason = 'workspace-root-unavailable';
        }
      }
    }
    if (root === null) {
      throw new BrowserError('VISION_BASELINE_ROOT_UNAVAILABLE', '没有可用的可信持久根，无法使用视觉基线', { reason });
    }
    return createBaselineStore({ root, scopeId: runtime.scope.id, now: () => Date.now() });
  }

  /** Evidence source projection (§3.2): product/baseline carry lineage only, live carries CaptureV1. */
  function t3EvidenceSource(resolved, role) {
    return {
      role,
      kind: resolved.kind,
      productId: resolved.product ? resolved.product.productId : null,
      sha256: resolved.sha256 ?? null,
      width: resolved.image ? resolved.image.width : (resolved.product ? resolved.product.width : null),
      height: resolved.image ? resolved.image.height : (resolved.product ? resolved.product.height : null),
      capturedAt: resolved.product ? resolved.product.capturedAt : null,
      mapping: resolved.product ? resolved.product.mapping : null,
      capture: resolved.kind === 'live' ? resolved.capture : null,
    };
  }

  /** Unified `evidence.vision` v1 (§3.2); every field is present, unknown observations are null. */
  function t3Evidence(input) {
    const provenance = input.provenance || {};
    const verdict = input.verdict || { status: 'INCONCLUSIVE', reason: 'no-assertion' };
    return {
      version: 1,
      operation: input.operation,
      provenance: {
        actionId: provenance.actionId ?? null,
        scopeId: provenance.scopeId ?? null,
        runtimeId: provenance.runtimeId ?? null,
        pageGeneration: Number.isInteger(provenance.pageGeneration) ? provenance.pageGeneration : null,
        documentEpoch: Number.isInteger(provenance.documentEpoch) ? provenance.documentEpoch : null,
        algorithmVersion: T3_ALGORITHM_VERSION,
      },
      source: Array.isArray(input.source) ? input.source : [],
      coordinateSpace: { image: 'image-px', document: 'document-css-px', input: 'viewport-css-px' },
      regions: Array.isArray(input.regions) ? input.regions : [],
      metrics: input.metrics && typeof input.metrics === 'object' ? input.metrics : {},
      baseline: Array.isArray(input.baseline) ? input.baseline : [],
      facts: Array.isArray(input.facts) ? input.facts : [],
      verdict: { status: verdict.status, reason: verdict.reason },
      dispatch: input.dispatch && typeof input.dispatch === 'object' ? {
        started: input.dispatch.started === true,
        eventCount: Number.isInteger(input.dispatch.eventCount) ? input.dispatch.eventCount : 0,
        completed: input.dispatch.completed === true,
        eventSource: input.dispatch.eventSource === 'cdp-input' ? 'cdp-input' : null,
        hitBackendNodeId: Number.isInteger(input.dispatch.hitBackendNodeId) ? input.dispatch.hitBackendNodeId : null,
      } : { started: false, eventCount: 0, completed: false, eventSource: null, hitBackendNodeId: null },
      output: input.output && typeof input.output === 'object' ? {
        productId: input.output.productId ?? null,
        sha256: input.output.sha256 ?? null,
        file: input.output.file ?? null,
        delivery: input.output.delivery ?? null,
      } : { productId: null, sha256: null, file: null, delivery: null },
      escalation: input.escalation && typeof input.escalation === 'object'
        ? { tier: input.escalation.tier === 'T4' ? 'T4' : null, reason: input.escalation.reason ?? null }
        : { tier: null, reason: null },
      incomplete: Array.isArray(input.incomplete) ? [...input.incomplete] : [],
      truncated: input.truncated === true,
    };
  }

  /**
   * Bound the evidence (§3.2): regions ≤100, JSON ≤262144 bytes. Only optional detail is dropped
   * (facts → baseline → capture payload → regions → warnings); totals, thresholds, dispatch and the
   * verdict always survive, and the loss is always reported via `truncated`.
   */
  function t3BoundEvidence(evidence) {
    if (evidence.regions.length > T3_EVIDENCE_REGIONS) {
      evidence.regions = evidence.regions.slice(0, T3_EVIDENCE_REGIONS);
      evidence.truncated = true;
    }
    const size = () => Buffer.byteLength(JSON.stringify(evidence), 'utf8');
    if (size() <= T3_EVIDENCE_BYTES) return evidence;
    evidence.truncated = true;
    const drops = [
      () => { if (evidence.facts.length) { evidence.facts = []; return true; } return false; },
      () => { if (evidence.baseline.length) { evidence.baseline = []; return true; } return false; },
      () => {
        for (const entry of evidence.source) {
          if (entry && entry.capture) {
            entry.capture = {
              version: 1,
              format: 'png',
              transport: 'cdp-page-capture-screenshot',
              png: { width: entry.width, height: entry.height, bytes: null, chunks: null, crc: null },
              file: null,
              truncated: true,
            };
            return true;
          }
        }
        return false;
      },
      () => { if (evidence.regions.length > 20) { evidence.regions = evidence.regions.slice(0, 20); return true; } return false; },
      () => { if (evidence.metrics && Array.isArray(evidence.metrics.warnings) && evidence.metrics.warnings.length) { evidence.metrics.warnings = []; return true; } return false; },
      () => { if (evidence.source.length > 4) { evidence.source = evidence.source.slice(0, 4); return true; } return false; },
    ];
    for (const drop of drops) {
      if (size() <= T3_EVIDENCE_BYTES) break;
      drop();
    }
    if (size() > T3_EVIDENCE_BYTES) {
      // Last resort: keep the verdict + dispatch + output, drop the bulky per-region detail.
      evidence.regions = [];
      evidence.metrics = { warnings: [], evidenceTruncated: true };
      evidence.incomplete = [...evidence.incomplete, 'evidence-truncated'];
    }
    return evidence;
  }

  /** Throw with the complete vision evidence attached (success and failure both carry it). */
  function t3ThrowWithEvidence(error, evidence) {
    const classified = error instanceof BrowserError ? error : new BrowserError('INTERNAL', String(error && error.message ? error.message : error));
    const bounded = t3BoundEvidence(evidence);
    classified.details = { ...classified.details, evidence: { ...classified.details?.evidence, vision: bounded } };
    return classified;
  }

  /**
   * Deliver exactly one PNG for a vision call, with the P0 rules unchanged: `output.out`,
   * `output.persist:true` or a configured env root persist; otherwise the plugin staging root.
   * The same bytes are offered to the attachments service; a missing/failed service falls back to
   * base64 without ever claiming the provider saw the image.
   */
  async function t3DeliverImage(runtime, exec, output, data, width, height, warnings) {
    const request = output || { persist: false, out: null };
    const envRoot = captureEnvRoot();
    const persistent = request.out !== null || request.persist === true || envRoot !== null;
    const defaultName = 'output/capture/' + exec.meta.actionId + '.png';
    let target = null;
    let rootSource = null;
    if (persistent) {
      const rootInfo = captureRootFor(exec);
      if (rootInfo.root === null) {
        throw new BrowserError('OUTPUT_PATH_INVALID', '没有可用的工作区根，无法持久落盘：请省略 output.out/persist 或设置 DSH_UI_TESTING_CAPTURE_DIR', {
          reason: 'root_unknown', outRequested: request.out !== null, persistRequested: request.persist === true,
        });
      }
      rootSource = rootInfo.source;
      const resolved = resolveCapturePath({ root: rootInfo.root, out: request.out === null ? undefined : request.out, defaultName });
      if (!resolved.ok) throw new BrowserError('OUTPUT_PATH_INVALID', resolved.message, resolved.details);
      target = resolved;
    }
    const sha256 = t3Sha256(data);
    let file = null;
    if (target) {
      const published = publishCapture(target.dir, target.absolutePath, data);
      if (!published.ok) throw new BrowserError(published.code, published.message, published.details);
      file = {
        path: target.relativePath, pathKind: 'relative', persistence: 'persistent',
        root: rootSource === 'env' ? 'env' : 'workspace', ephemeral: false,
        bytes: published.bytes, sha256, width, height, mode: published.mode, noClobber: true,
        createdAt: published.createdAt,
      };
    } else {
      try {
        const stagingRoot = ensureCaptureStagingRoot();
        const absolutePath = join(stagingRoot, exec.meta.actionId + '.png');
        const published = publishCapture(stagingRoot, absolutePath, data);
        if (!published.ok) throw new Error('staging publish failed: ' + published.code);
        file = {
          path: absolutePath, pathKind: 'absolute', persistence: 'staging', root: 'staging',
          ephemeral: true, bytes: published.bytes, sha256, width, height, mode: published.mode,
          noClobber: true, createdAt: published.createdAt,
        };
      } catch {
        t3Warning(warnings, 'capture_file_unavailable');
      }
    }
    const delivery = {
      original: { width, height, bytes: data.length, sha256, mediaType: 'image/png' },
      image: null, downscaled: false, reencoded: false,
    };
    let attachment;
    let attachmentError;
    let imageDelivery = 'base64-fallback';
    if (typeof attachments?.saveImage === 'function') {
      try {
        attachment = projectAttachment(await abortable(
          attachments.saveImage({ data, mediaType: 'image/png', name: `ui-testing-${exec.meta.actionId}.png` }),
          exec.signal,
        ));
      } catch (error) {
        if (error && error.code === 'ABORTED') throw error;
        attachmentError = '附件保存失败，使用 base64-fallback';
      }
      if (attachment) {
        imageDelivery = 'attachment';
        const refWidth = Number.isFinite(attachment.width) ? attachment.width : null;
        const refHeight = Number.isFinite(attachment.height) ? attachment.height : null;
        const refBytes = Number.isFinite(attachment.bytes) ? attachment.bytes : null;
        const refMediaType = typeof attachment.mediaType === 'string' ? attachment.mediaType : null;
        delivery.image = { width: refWidth, height: refHeight, bytes: refBytes, mediaType: refMediaType };
        if ((refWidth !== null && refWidth < width) || (refHeight !== null && refHeight < height)) {
          delivery.downscaled = true;
          t3Warning(warnings, 'model_image_downscaled');
        }
        if ((refMediaType !== null && refMediaType !== 'image/png')
          || (refBytes !== null && refBytes !== data.length)
          || (typeof attachment.sha256 === 'string' && attachment.sha256 !== sha256)) {
          delivery.reencoded = true;
          t3Warning(warnings, 'attachment_reencoded');
        }
      }
    } else {
      t3Warning(warnings, 'attachment_unavailable');
    }
    return {
      sha256, file, delivery,
      attachment, attachmentError, imageDelivery,
      attachmentId: attachment ? (attachment.attachmentId || attachment.id || null) : null,
    };
  }

  /** Encode a processed image with the module encoder and validate the delivered PNG. */
  async function t3EncodeImage(image, signal, budget) {
    const bytes = await vision.encodePngRgbaAsync(image, t3AlgoOpts(budget, signal));
    if (!Buffer.isBuffer(bytes) && !(bytes instanceof Uint8Array)) {
      throw new BrowserError('INTERNAL', 'PNG 编码器未返回字节');
    }
    const data = Buffer.isBuffer(bytes) ? bytes : Buffer.from(bytes);
    if (data.length > T3_LIMITS.maxOutputBytes) {
      throw new BrowserError('VISION_LIMIT_EXCEEDED', '编码 PNG 超过单图字节上限', {
        limit: 'maxOutputBytes', actual: data.length, max: T3_LIMITS.maxOutputBytes,
      });
    }
    if (image.width * image.height > T3_LIMITS.maxOutputPixels) {
      throw new BrowserError('VISION_LIMIT_EXCEEDED', '输出图像超过像素上限', {
        limit: 'maxOutputPixels', actual: image.width * image.height, max: T3_LIMITS.maxOutputPixels,
      });
    }
    const png = inspectPng(data, { checkCrc: true });
    if (!png.ok) throw new BrowserError('INVALID_PNG', '编码结果未通过 PNG 结构/CRC 校验', { phase: 'inspectPng', reason: png.message });
    if (png.width !== image.width || png.height !== image.height) {
      throw new BrowserError('CAPTURE_SIZE_MISMATCH', '编码结果尺寸与内存图像不一致', {
        actual: { width: png.width, height: png.height }, expected: { width: image.width, height: image.height },
      });
    }
    return { data, png };
  }

  /** Validate an image-space PixelRect against an image (integer, inside, no clamping). */
  function t3RectInside(rect, image, name) {
    if (rect.x + rect.width > image.width || rect.y + rect.height > image.height) {
      throw t3Invalid(`${name} 超出图像边界`, {
        path: name, reason: 'rect-outside-image',
        image: { width: image.width, height: image.height },
      });
    }
    return rect;
  }
  function t3NormalizeOutput(value) {
    if (value === undefined || value === null) return { persist: false, out: null };
    return vision.validateOutput(value, 'output');
  }

  /** Validate one `Case.assertions[].type`-specific assertion (unknown fields rejected). */
  function t3Assertion(value, name) {
    const assertion = t2Object(value, name);
    t2RejectUnknown(assertion, [
      'id', 'type', 'severity', 'baseline', 'revision', 'region', 'factId', 'expectedRect',
      'toleranceCss', 'maxCoveredRatio', 'expectedColor', 'tolerance', 'minFraction', 'query', 'minCount',
      'masks', 'options', 'thresholds',
    ], name);
    const id = t2StringField(assertion.id, { name: `${name}.id`, maxBytes: 64 });
    if (!/^[a-zA-Z0-9][a-zA-Z0-9_-]{0,63}$/.test(id)) throw t3Invalid(`${name}.id 必须是合法 Name`, { path: `${name}.id` });
    const type = t2StringField(assertion.type, { name: `${name}.type`, maxBytes: 32 });
    if (!T3_ASSERTION_TYPES.includes(type)) throw t3Invalid(`${name}.type 必须是 ${T3_ASSERTION_TYPES.join('/')}`, { path: `${name}.type` });
    const severity = assertion.severity === undefined ? 'required' : assertion.severity;
    if (severity !== 'required' && severity !== 'advisory') throw t3Invalid(`${name}.severity 只能是 required/advisory`, { path: `${name}.severity` });
    const allowedByType = {
      regression: ['id', 'type', 'severity', 'baseline', 'revision', 'region', 'masks', 'options', 'thresholds'],
      layout: ['id', 'type', 'severity', 'region', 'factId', 'expectedRect', 'toleranceCss'],
      occlusion: ['id', 'type', 'severity', 'region', 'factId', 'maxCoveredRatio'],
      overflow: ['id', 'type', 'severity', 'region', 'factId', 'toleranceCss'],
      truncation: ['id', 'type', 'severity', 'region', 'factId', 'toleranceCss'],
      color: ['id', 'type', 'severity', 'region', 'factId', 'expectedColor', 'tolerance', 'minFraction'],
      missing: ['id', 'type', 'severity', 'region', 'factId', 'query', 'minCount'],
    };
    t2RejectUnknown(assertion, allowedByType[type], `${name}(${type})`);
    const out = { id, type, severity };
    if (type === 'regression') {
      const baseline = t2StringField(assertion.baseline, { name: `${name}.baseline`, maxBytes: 64 });
      if (!/^[a-zA-Z0-9][a-zA-Z0-9_-]{0,63}$/.test(baseline)) throw t3Invalid(`${name}.baseline 必须是合法 Name`, { path: `${name}.baseline` });
      out.baseline = baseline;
      out.revision = assertion.revision === undefined ? undefined : t2IntegerField(assertion.revision, undefined, 1, 9999999999, `${name}.revision`);
      out.region = assertion.region === undefined ? undefined : vision.validatePixelRect(assertion.region, `${name}.region`);
      out.masks = assertion.masks === undefined ? undefined : vision.validateMasks(assertion.masks, `${name}.masks`);
      out.options = assertion.options === undefined ? undefined : vision.validateDiffOptions(assertion.options, `${name}.options`);
      out.thresholds = assertion.thresholds === undefined ? undefined : vision.validateThresholds(assertion.thresholds, `${name}.thresholds`);
    } else {
      out.region = vision.validatePixelRect(assertion.region, `${name}.region`);
      out.factId = assertion.factId === undefined ? undefined : t2StringField(assertion.factId, { name: `${name}.factId`, maxBytes: 64 });
      if (out.factId !== undefined && !/^[a-zA-Z0-9][a-zA-Z0-9_-]{0,63}$/.test(out.factId)) throw t3Invalid(`${name}.factId 必须是合法 Name`, { path: `${name}.factId` });
      if (type === 'layout') {
        out.expectedRect = assertion.expectedRect === undefined ? undefined : vision.validateCssRect(assertion.expectedRect, `${name}.expectedRect`);
        if (out.expectedRect !== undefined && out.factId === undefined) throw t3Invalid(`${name}.expectedRect 必须同时提供 factId`, { path: `${name}.expectedRect` });
        out.toleranceCss = t2NumberField(assertion.toleranceCss, 1, 0, 100, `${name}.toleranceCss`);
      } else if (type === 'occlusion') {
        out.maxCoveredRatio = t2NumberField(assertion.maxCoveredRatio, 0, 0, 1, `${name}.maxCoveredRatio`);
      } else if (type === 'overflow' || type === 'truncation') {
        out.toleranceCss = t2NumberField(assertion.toleranceCss, 1, 0, 100, `${name}.toleranceCss`);
      } else if (type === 'color') {
        out.expectedColor = t3Rgb(assertion.expectedColor, `${name}.expectedColor`);
        out.tolerance = t2IntegerField(assertion.tolerance, 16, 0, 255, `${name}.tolerance`);
        out.minFraction = t2NumberField(assertion.minFraction, 0.95, 0, 1, `${name}.minFraction`);
      } else if (type === 'missing') {
        out.query = vision.validateQuery(assertion.query, `${name}.query`);
        out.minCount = t2IntegerField(assertion.minCount, 1, 1, 100, `${name}.minCount`);
      }
    }
    return out;
  }

  /** `RGB` = three integers 0–255, given as `[r,g,b]` or `{r,g,b}` (contract §1.2). */
  function t3Rgb(value, name) {
    let parts;
    if (Array.isArray(value)) {
      parts = value;
    } else if (value && typeof value === 'object') {
      t2RejectUnknown(value, ['r', 'g', 'b'], name);
      if (value.r === undefined || value.g === undefined || value.b === undefined) {
        throw t3Invalid(`${name} 必须是 [r,g,b] 或 {r,g,b}`, { path: name });
      }
      parts = [value.r, value.g, value.b];
    } else {
      throw t3Invalid(`${name} 必须是 [r,g,b] 或 {r,g,b}`, { path: name });
    }
    if (parts.length !== 3) throw t3Invalid(`${name} 必须是 3 个整数通道`, { path: name });
    for (const channel of parts) {
      if (typeof channel !== 'number' || !Number.isInteger(channel) || channel < 0 || channel > 255) {
        throw t3Invalid(`${name} 每个通道必须是 0–255 整数`, { path: name });
      }
    }
    return [parts[0], parts[1], parts[2]];
  }

  /** `RGBA` = four integers 0–255, given as `[r,g,b,a]` or `{r,g,b,a}` (contract §1.2). */
  function t3Rgba(value, name) {
    let parts;
    if (Array.isArray(value)) {
      parts = value;
    } else if (value && typeof value === 'object') {
      t2RejectUnknown(value, ['r', 'g', 'b', 'a'], name);
      if (value.r === undefined || value.g === undefined || value.b === undefined || value.a === undefined) {
        throw t3Invalid(`${name} 必须是 [r,g,b,a] 或 {r,g,b,a}`, { path: name });
      }
      parts = [value.r, value.g, value.b, value.a];
    } else {
      throw t3Invalid(`${name} 必须是 [r,g,b,a] 或 {r,g,b,a}`, { path: name });
    }
    if (parts.length !== 4) throw t3Invalid(`${name} 必须是 4 个整数通道`, { path: name });
    for (const channel of parts) {
      if (typeof channel !== 'number' || !Number.isInteger(channel) || channel < 0 || channel > 255) {
        throw t3Invalid(`${name} 每个通道必须是 0–255 整数`, { path: name });
      }
    }
    return [parts[0], parts[1], parts[2], parts[3]];
  }


  /* --- T3 request validators (pure, no browser/file access) -------------------------------- */
  function t3Resize(value) {
    const object = t2Object(value, 'resize');
    t2RejectUnknown(object, ['factor', 'method'], 'resize');
    const factor = t2NumberField(object.factor, undefined, 1, 4, 'resize.factor');
    const method = object.method === undefined ? 'nearest' : object.method;
    if (method !== 'nearest' && method !== 'bilinear') throw t3Invalid('resize.method 只能是 nearest/bilinear', { path: 'resize.method' });
    return { factor, method };
  }
  function t3PreprocessParameters(op) {
    const parameters = {};
    for (const key of ['radius', 'value', 'order']) {
      if (op && op[key] !== undefined) parameters[key] = op[key];
    }
    return parameters;
  }

  /** `browser_vision_image` root arguments (contract §2.1/§2.2). */
  function t3ImageRequest(input) {
    t2RejectUnknown(input, ['source', 'region', 'resize', 'preprocess', 'annotations', 'recognize', 'output'], 'browser_vision_image');
    return {
      source: vision.validateSource(input.source, 'source'),
      region: input.region === undefined ? null : vision.validatePixelRect(input.region, 'region'),
      resize: input.resize === undefined ? null : t3Resize(input.resize),
      preprocess: vision.validatePreprocess(input.preprocess, 'preprocess'),
      annotations: vision.validateAnnotations(input.annotations, 'annotations'),
      recognize: input.recognize === undefined ? null : vision.validateQuery(input.recognize, 'recognize'),
      output: t3NormalizeOutput(input.output),
    };
  }

  /** `browser_vision_find` root arguments (contract §2.1/§2.3). */
  function t3FindRequest(input) {
    t2RejectUnknown(input, ['source', 'region', 'query'], 'browser_vision_find');
    if (input.query === undefined || input.query === null) throw t3Invalid('query 必填', { path: 'query' });
    return {
      source: vision.validateSource(input.source, 'source'),
      region: input.region === undefined ? null : vision.validatePixelRect(input.region, 'region'),
      query: vision.validateQuery(input.query, 'query'),
    };
  }

  /** `browser_vision_compare` root arguments (contract §2.1/§2.4). */
  function t3CompareRequest(input) {
    t2RejectUnknown(input, ['before', 'after', 'region', 'masks', 'options', 'thresholds', 'output'], 'browser_vision_compare');
    if (input.before === undefined || input.before === null) throw t3Invalid('before 必填（必须显式给出）', { path: 'before' });
    if (input.after === undefined || input.after === null) throw t3Invalid('after 必填（必须显式给出）', { path: 'after' });
    return {
      before: vision.validateSource(input.before, 'before'),
      after: vision.validateSource(input.after, 'after'),
      region: input.region === undefined ? null : vision.validatePixelRect(input.region, 'region'),
      masksProvided: input.masks !== undefined,
      masks: input.masks === undefined ? [] : vision.validateMasks(input.masks, 'masks'),
      optionsProvided: input.options !== undefined,
      options: input.options === undefined ? null : vision.validateDiffOptions(input.options, 'options'),
      thresholdsProvided: input.thresholds !== undefined,
      thresholds: input.thresholds === undefined ? null : vision.validateThresholds(input.thresholds, 'thresholds'),
      output: t3NormalizeOutput(input.output),
    };
  }

  /** `browser_vision_act` root arguments (contract §2.1/§2.5). */
  function t3ActRequest(input) {
    t2RejectUnknown(input, ['productId', 'action', 'point', 'to', 'button', 'clickCount', 'modifiers', 'steps', 'durationMs'], 'browser_vision_act');
    const productId = t2StringField(input.productId, { name: 'productId', maxBytes: 64 });
    if (!/^v1_[0-9a-f]{32}$/.test(productId)) throw t3Invalid('productId 必须匹配 ^v1_[0-9a-f]{32}$', { path: 'productId' });
    const action = t2StringField(input.action, { name: 'action', maxBytes: 8 });
    if (!['move', 'click', 'drag'].includes(action)) throw t3Invalid('action 只能是 move/click/drag', { path: 'action' });
    const point = vision.validatePoint(input.point, 'point');
    const hasTo = input.to !== undefined && input.to !== null;
    if (action === 'drag' && !hasTo) throw t3Invalid('drag 必须提供 to', { path: 'to' });
    if (action !== 'drag' && hasTo) throw t3Invalid(`${action} 不接受 to`, { path: 'to' });
    const to = hasTo ? vision.validatePoint(input.to, 'to') : null;
    const hasButton = input.button !== undefined;
    const hasClickCount = input.clickCount !== undefined;
    const hasSteps = input.steps !== undefined;
    const hasDuration = input.durationMs !== undefined;
    if (action === 'move') {
      if (hasButton) throw t3Invalid('move 不接受 button', { path: 'button' });
      if (hasClickCount) throw t3Invalid('move 不接受 clickCount', { path: 'clickCount' });
      if (hasSteps) throw t3Invalid('move 不接受 steps', { path: 'steps' });
      if (hasDuration) throw t3Invalid('move 不接受 durationMs', { path: 'durationMs' });
    }
    if (action === 'click' && hasSteps) throw t3Invalid('click 不接受 steps', { path: 'steps' });
    if (action === 'click' && hasDuration) throw t3Invalid('click 不接受 durationMs', { path: 'durationMs' });
    if (action === 'drag' && hasClickCount) throw t3Invalid('drag 不接受 clickCount', { path: 'clickCount' });
    const button = hasButton ? input.button : 'left';
    if (!['left', 'right', 'middle'].includes(button)) throw t3Invalid('button 只能是 left/right/middle', { path: 'button' });
    const clickCount = action === 'click'
      ? t2IntegerField(input.clickCount, 1, 1, 2, 'clickCount')
      : 1;
    const modifiers = t2ModifierList(input.modifiers);
    const steps = action === 'drag' ? t2IntegerField(input.steps, 20, 1, 100, 'steps') : 0;
    const durationMs = action === 'drag' ? t2IntegerField(input.durationMs, 500, 0, 2000, 'durationMs') : 0;
    return { productId, action, point, to, button, clickCount, modifiers, steps, durationMs };
  }

  /** `browser_vision_baseline` root arguments (contract §2.1/§2.6). */
  function t3BaselineRequest(input) {
    t2RejectUnknown(input, ['action', 'name', 'revision', 'source', 'expectedRevision', 'caseId', 'options', 'thresholds', 'masks'], 'browser_vision_baseline');
    const action = t2StringField(input.action, { name: 'action', maxBytes: 16 });
    if (!['list', 'get', 'create', 'update', 'delete'].includes(action)) {
      throw t3Invalid('action 只能是 list/get/create/update/delete', { path: 'action' });
    }
    const present = (key) => input[key] !== undefined && input[key] !== null;
    const name = present('name') ? t2StringField(input.name, { name: 'name', maxBytes: 64 }) : null;
    if (name !== null && !/^[a-zA-Z0-9][a-zA-Z0-9_-]{0,63}$/.test(name)) {
      throw new BrowserError('VISION_BASELINE_NAME_INVALID', '基线 name 必须匹配 ^[a-zA-Z0-9][a-zA-Z0-9_-]{0,63}$', { name: null });
    }
    const revision = present('revision') ? t2IntegerField(input.revision, undefined, 1, 9999999999, 'revision') : null;
    const expectedRevision = present('expectedRevision') ? t2IntegerField(input.expectedRevision, undefined, 1, 9999999999, 'expectedRevision') : null;
    const caseId = present('caseId') ? t2StringField(input.caseId, { name: 'caseId', maxBytes: 64 }) : null;
    if (caseId !== null && !/^[a-zA-Z0-9][a-zA-Z0-9_-]{0,63}$/.test(caseId)) throw t3Invalid('caseId 必须是合法 Name', { path: 'caseId' });
    const source = present('source') ? vision.validateSource(input.source, 'source') : null;
    const options = present('options') ? vision.validateDiffOptions(input.options, 'options') : null;
    const thresholds = present('thresholds') ? vision.validateThresholds(input.thresholds, 'thresholds') : null;
    // update 的 options/thresholds 按字段继承旧 HEAD 值：必须传用户给出的 partial 对象，不能传
    // 补齐默认值的完整对象，否则会静默覆盖未提供的旧字段（契约 §2.6/§8.3）。
    const optionsPartial = present('options') ? { ...input.options } : null;
    const thresholdsPartial = present('thresholds') ? { ...input.thresholds } : null;
    const masksProvided = input.masks !== undefined;
    const masks = input.masks === undefined ? [] : vision.validateMasks(input.masks, 'masks');
    const forbidden = (keys) => {
      for (const key of keys) if (present(key)) throw t3Invalid(`${action} 不接受字段：${key}`, { path: key });
    };
    if (action === 'list') {
      forbidden(['name', 'revision', 'source', 'expectedRevision', 'caseId', 'options', 'thresholds']);
      if (masksProvided) throw t3Invalid('list 不接受字段：masks', { path: 'masks' });
    } else if (action === 'get') {
      if (name === null) throw t3Invalid('get 必须提供 name', { path: 'name' });
      forbidden(['source', 'expectedRevision', 'caseId', 'options', 'thresholds']);
      if (masksProvided) throw t3Invalid('get 不接受字段：masks', { path: 'masks' });
    } else if (action === 'create') {
      if (name === null) throw t3Invalid('create 必须提供 name', { path: 'name' });
      if (source === null) throw t3Invalid('create 必须提供 source', { path: 'source' });
      forbidden(['revision', 'expectedRevision']);
    } else if (action === 'update') {
      if (name === null) throw t3Invalid('update 必须提供 name', { path: 'name' });
      if (source === null) throw t3Invalid('update 必须提供 source', { path: 'source' });
      if (expectedRevision === null) throw t3Invalid('update 必须提供 expectedRevision', { path: 'expectedRevision' });
      forbidden(['revision']);
    } else {
      if (name === null) throw t3Invalid('delete 必须提供 name', { path: 'name' });
      if (expectedRevision === null) throw t3Invalid('delete 必须提供 expectedRevision', { path: 'expectedRevision' });
      forbidden(['revision', 'source', 'caseId', 'options', 'thresholds']);
      if (masksProvided) throw t3Invalid('delete 不接受字段：masks', { path: 'masks' });
    }
    return {
      action, name, revision, source, expectedRevision, caseId, options, thresholds,
      optionsPartial, thresholdsPartial, masks, masksProvided,
    };
  }

  /**
   * §6.2: a candidate that maps entirely outside the content box sits on blank canvas → its
   * documentCss is null (the pixel result is still reported). Only canvas-space mappings carry
   * blank semantics; O = 0 keeps the historical document behaviour unchanged.
   */
  function t3CanvasRectBlank(mapping, rect) {
    if (!mapping || mapping.coordinateSpace !== 'canvas-css-px' || !rect) return false;
    const width = mapping.canvas && Number.isFinite(mapping.canvas.contentWidth) ? mapping.canvas.contentWidth : null;
    const height = mapping.canvas && Number.isFinite(mapping.canvas.contentHeight) ? mapping.canvas.contentHeight : null;
    if (!Number.isFinite(width) || !Number.isFinite(height)) return false;
    return rect.x + rect.width <= 0 || rect.x >= width || rect.y + rect.height <= 0 || rect.y >= height;
  }

  /** FindResult projection (§2.3): the module already returns full-image coordinates. */
  function t3FindResult(query, found, image, sourceProduct, mapping, searchRegion) {
    const candidates = Array.isArray(found && found.candidates) ? found.candidates : [];
    return {
      method: query.method,
      sourceProductId: sourceProduct ? sourceProduct.productId : null,
      searchRegion: searchRegion ?? { x: 0, y: 0, width: image.width, height: image.height },
      candidates: candidates.map((candidate) => {
        const mapped = mapping ? vision.mapImageRectToDocument(mapping, candidate.region) : null;
        const blank = t3CanvasRectBlank(mapping, mapped);
        return {
          id: candidate.id,
          region: candidate.region,
          // Canvas and document coordinates coincide; blank candidates keep the canvas rect but
          // must not be treated as document points (docs/viewport-control.md).
          canvas: mapped,
          documentCss: blank ? null : mapped,
          centroid: candidate.centroid,
          area: candidate.area,
          score: candidate.score,
          signal: candidate.signal,
          semanticName: null,
        };
      }),
      totalCandidates: Number.isInteger(found && found.totalCandidates) ? found.totalCandidates : candidates.length,
      truncated: Boolean(found && found.truncated),
      metrics: found && found.metrics ? found.metrics : {
        foregroundPixels: null, evaluatedPositions: null, pixelComparisons: 0, algorithm: 'unknown',
      },
    };
  }

  /** Resolve a template Query source (product/baseline only); returns the resolved source or null. */
  async function t3TemplateImage(runtime, exec, query, pins, budget, liveScale = null) {
    if (!query || query.method !== 'template') return null;
    const template = query.template;
    if (!template) throw t3Invalid('template 查询必须提供 template source', { path: 'template' });
    if (template.kind === 'live') throw t3Invalid('template source 只能是 product 或 baseline', { path: 'template' });
    return t3ResolveSource(runtime, exec, template, 'template', pins, budget, liveScale);
  }
  function t3MergeResolved(base, provided, validator, name) {
    if (provided === null || provided === undefined) return { ...base };
    const normalized = validator(provided, name);
    const merged = { ...base };
    for (const key of Object.keys(provided)) {
      if (Object.hasOwn(normalized, key)) merged[key] = normalized[key];
    }
    return merged;
  }

  /** A ratio verdict from the module when available (equal → lower level). */
  function t3RatioVerdict(diffRatio, thresholds) {
    if (typeof vision.ratioVerdict === 'function') return vision.ratioVerdict(diffRatio, thresholds);
    if (!(diffRatio > thresholds.failRatio)) return diffRatio > thresholds.warnRatio ? 'WARN' : 'PASS';
    return 'FAIL';
  }
  function t3ValidateMaskBounds(masks, image) {
    const seen = new Set();
    masks.forEach((mask, index) => {
      if (seen.has(mask.id)) throw t3Invalid(`masks[${index}].id 重复`, { path: `masks[${index}].id` });
      seen.add(mask.id);
      const region = mask.region;
      if (region.x + region.width > image.width || region.y + region.height > image.height) {
        throw t3Invalid(`masks[${index}].region 超出图像边界`, {
          path: `masks[${index}].region`,
          image: { width: image.width, height: image.height },
        });
      }
    });
  }
  function t3EvidenceRegion(entry) {
    return {
      id: entry.id,
      role: entry.role,
      imagePixels: entry.imagePixels,
      beforeDocumentCss: entry.beforeDocumentCss ?? null,
      afterDocumentCss: entry.afterDocumentCss ?? null,
      area: Number.isInteger(entry.area) ? entry.area : null,
    };
  }

  /* --- browser_vision_image ---------------------------------------------------------------- */
  register({
    name: 'browser_vision_image',
    description: 'T3 静态视觉：对一张 PNG（live 截图 / product / 基线）做 region 裁剪、resize、预处理、全量统计、可选确定性识别（color/components/edges/template）与像素标注，并交付一张 PNG。'
      + '处理顺序固定：source → region → resize → preprocess → 统计/识别 → annotations → 编码/校验/交付；分析与识别在标注之前，regions 坐标相对最终未标注图。'
      + '无参数即一张实时截图加统计；未请求断言时 verdict=INCONCLUSIVE（reason=no-assertion），截图/识别成功都不等于视觉验收通过。'
      + '不提供 VLM/OCR/语义命名，也不读 DOM。',
    parameters: {
      type: 'object',
      additionalProperties: false,
      required: [],
      properties: {
        source: {
          type: 'object',
          description: '源图：{kind:"live",scale?:0.1–4,region?:文档CSS Rect} | {kind:"product",productId:"v1_<32hex>"} | {kind:"baseline",name,revision?}；默认 live。'
            + 'live 省略 scale 时使用本次调用开始时冻结的共享显示比例 view.scale（默认 100%），显式值覆盖且只影响本次采集。',
        },
        region: {
          type: 'object',
          description: '图像像素裁剪 Rect（integer，左闭右开，必须完全在图内）；省略为整图。',
          properties: { x: { type: 'integer' }, y: { type: 'integer' }, width: { type: 'integer' }, height: { type: 'integer' } },
          required: ['x', 'y', 'width', 'height'],
        },
        resize: {
          type: 'object',
          description: '事后位图插值（与 source.scale 的 CDP 光栅密度无关）：factor 连续 1–4（不支持缩小），method nearest/bilinear。',
          properties: { factor: { type: 'number' }, method: { type: 'string', enum: ['nearest', 'bilinear'] } },
          required: ['factor'],
        },
        preprocess: {
          type: 'array',
          description: '按列表顺序执行：grayscale/blur(radius 1–3)/normalize/threshold(value 0–255)/channels(order rgba/bgra/argb)，最多 8 项。',
          items: { type: 'object' },
        },
        annotations: {
          type: 'array',
          description: '整数像素标注：rect(region)/cross(point,size?)/number(point,number 1–999)/arrow(point,to)，color RGBA、thickness 1–8，最多 64 项；列表顺序即覆盖顺序。',
          items: { type: 'object' },
        },
        recognize: {
          type: 'object',
          description: '可选确定性识别 Query（同 browser_vision_find 的 query）；template 只接受 product/baseline 源。',
        },
        output: {
          type: 'object',
          description: '交付 PNG 的落盘选择：persist?:boolean=false（默认写插件暂存目录），out?:工作区相对 .png（提供即持久）。0600、原子写入、绝不覆盖；同 out 冲突返回 OUTPUT_EXISTS。',
          properties: { persist: { type: 'boolean' }, out: { type: 'string' } },
          required: [],
        },
      },
    },
    output: { schema: { type: 'object' }, render: (args, value) => {
      const { image, attachment, ...meta } = value;
      return attachment ? [{ type: 'image', attachment }, ...text(meta)] : text({ ...meta, image });
    } },
    async execute(args, exec) {
      const runtime = exec.runtime;
      const provenance = t3Provenance(runtime, exec);
      const pins = [];
      const budget = t3NewBudget();
      const warnings = [];
      const incomplete = [];
      let resolved = null;
      try {
        const request = t3ImageRequest(args && typeof args === 'object' ? args : {});
        // One frozen default scale per call (docs/viewport-control.md).
        const liveScale = runtime.view.scale;
        resolved = await t3ResolveSource(runtime, exec, request.source, 'source', pins, budget, liveScale);
        let image = resolved.image;
        let mapping = resolved.product ? resolved.product.mapping : null;
        let actionable = resolved.product ? resolved.product.actionable === true : false;
        const sourceProduct = resolved.product;
        const operations = [];
        if (request.region) {
          t3RectInside(request.region, image, 'region');
          image = await vision.cropImageAsync(image, request.region, t3AlgoOpts(budget, exec.signal));
          mapping = typeof vision.mappingAfterCrop === 'function' ? vision.mappingAfterCrop(mapping, request.region) : mapping;
          operations.push({ op: 'crop', parameters: { region: { ...request.region } } });
        }
        if (request.resize) {
          const outputWidth = Math.round(image.width * request.resize.factor);
          const outputHeight = Math.round(image.height * request.resize.factor);
          if (outputWidth < 1 || outputHeight < 1) throw t3Invalid('resize 结果尺寸必须 ≥1', { path: 'resize.factor' });
          if (outputWidth * outputHeight > T3_LIMITS.maxProductPixels) {
            throw new BrowserError('VISION_LIMIT_EXCEEDED', 'resize 结果超过单图像素上限', {
              limit: 'maxProductPixels', actual: outputWidth * outputHeight, max: T3_LIMITS.maxProductPixels,
            });
          }
          image = await vision.resizeImageAsync(image, request.resize.factor, request.resize.method, t3AlgoOpts(budget, exec.signal));
          mapping = typeof vision.mappingAfterResize === 'function'
            ? vision.mappingAfterResize(mapping, outputWidth, outputHeight)
            : mapping;
          operations.push({ op: 'resize', parameters: { factor: request.resize.factor, method: request.resize.method } });
          t3Warning(warnings, 'bitmap-upscaled');
          if (request.resize.method !== 'nearest') actionable = false;
        }
        for (const op of request.preprocess) {
          image = await vision.preprocessImageAsync(image, [op], t3AlgoOpts(budget, exec.signal));
          operations.push({ op: op.op, parameters: t3PreprocessParameters(op) });
          actionable = false;
        }
        // Analysis + recognition happen BEFORE annotations (annotations are not page content).
        const analysis = await vision.analyzeImageAsync(image, t3AlgoOpts(budget, exec.signal));
        let found = null;
        let templateResolved = null;
        if (request.recognize) {
          templateResolved = await t3TemplateImage(runtime, exec, request.recognize, pins, budget);
          found = await vision.findInImageAsync(image, request.recognize, {
            roi: { x: 0, y: 0, width: image.width, height: image.height },
            templateImage: templateResolved ? templateResolved.image : null,
            ...t3AlgoOpts(budget, exec.signal),
          }, t3AlgoOpts(budget, exec.signal));
        }
        let processedProduct = sourceProduct;
        let processedBytes = resolved.bytes;
        let finalImage = image;
        if (operations.length) {
          const encoded = await t3EncodeImage(image, exec.signal, budget);
          processedBytes = encoded.data;
          processedProduct = t3ProductPublic(t3AddProduct(runtime, {
            bytes: encoded.data, width: image.width, height: image.height,
            sha256: encoded.sha256, rgbaSha256: t3RgbaSha256(image.rgba), kind: 'derived',
            mapping, actionable, parentIds: [sourceProduct.productId], operations,
            capturedAt: sourceProduct.capturedAt,
            provenance: { ...provenance, capture: resolved.captureFacts ?? null },
          }));
        }
        const recognition = found
          ? t3FindResult(request.recognize, found, image, processedProduct, mapping, { x: 0, y: 0, width: image.width, height: image.height })
          : null;
        let finalProduct = processedProduct;
        let finalBytes = processedBytes;
        if (request.annotations.length) {
          finalImage = await vision.annotateImageAsync(image, request.annotations, t3AlgoOpts(budget, exec.signal));
          const encoded = await t3EncodeImage(finalImage, exec.signal, budget);
          finalBytes = encoded.data;
          finalProduct = t3ProductPublic(t3AddProduct(runtime, {
            bytes: encoded.data, width: finalImage.width, height: finalImage.height,
            sha256: encoded.sha256, rgbaSha256: t3RgbaSha256(finalImage.rgba), kind: 'derived',
            mapping, actionable: false, parentIds: [processedProduct.productId],
            operations: [{ op: 'annotate', parameters: { annotations: request.annotations } }],
            capturedAt: processedProduct.capturedAt,
            provenance: { ...provenance, capture: resolved.captureFacts ?? null },
          }));
        }
        const delivered = await t3DeliverImage(runtime, exec, request.output, finalBytes, finalImage.width, finalImage.height, warnings);
        const metrics = {
          pixelCount: analysis.pixelCount,
          transparentPixels: analysis.transparentPixels,
          opaquePixels: analysis.opaquePixels,
          uniform: analysis.uniform,
          edgePixels: analysis.edgePixels,
          edgeRatio: analysis.edgeRatio,
          operationCount: operations.length,
          annotated: request.annotations.length > 0,
          recognized: recognition ? recognition.totalCandidates : null,
          warnings,
        };
        const evidence = t3BoundEvidence(t3Evidence({
          operation: 'image',
          provenance,
          source: templateResolved
            ? [t3EvidenceSource(resolved, 'source'), t3EvidenceSource(templateResolved, 'template')]
            : [t3EvidenceSource(resolved, 'source')],
          regions: [],
          metrics,
          verdict: { status: 'INCONCLUSIVE', reason: 'no-assertion' },
          output: { productId: finalProduct.productId, sha256: delivered.sha256, file: delivered.file, delivery: delivered.delivery },
          incomplete,
        }));
        runtime.noteVisionOperation('image', 'INCONCLUSIVE');
        return {
          ok: true,
          product: finalProduct,
          image: finalBytes.toString('base64'),
          bytes: finalBytes.length,
          sha256: delivered.sha256,
          attachment: delivered.attachment,
          attachmentId: delivered.attachmentId,
          imageDelivery: delivered.imageDelivery,
          attachmentError: delivered.attachmentError,
          file: delivered.file,
          analysis,
          recognition,
          // §1.2: the success body nests the vision evidence exactly like the error path.
          evidence: { vision: evidence },
        };
      } catch (error) {
        const evidence = t3Evidence({
          operation: 'image',
          provenance,
          source: resolved ? [t3EvidenceSource(resolved, 'source')] : [],
          verdict: { status: 'BLOCKED', reason: 'error' },
          metrics: { errorCode: error && error.code ? error.code : 'INTERNAL', warnings },
          incomplete: [...incomplete, 'operation-failed'],
        });
        runtime.noteVisionOperation('image', null);
        throw t3ThrowWithEvidence(error, evidence);
      } finally {
        t3ReleasePins(runtime, pins);
      }
    },
  });

  /* --- browser_vision_find ----------------------------------------------------------------- */
  register({
    name: 'browser_vision_find',
    description: 'T3 静态视觉：在源图（可先按 region 裁出 ROI）上做确定性识别并定位，返回 FindResult。'
      + 'method=color/components/edges/template；候选坐标始终相对完整源图（ROI 原点已回加），documentCss 用 mapping 映射。'
      + '无匹配是成功（candidates:[],totalCandidates:0），不是 TARGET_NOT_FOUND；candidates 只是本次排序编号，不是可操作 ref，也不是 DOM 身份或语义命名（semanticName 恒 null）。'
      + '默认不生成图片、文件或额外 product（live 源仍会生成可引用源 product）。',
    parameters: {
      type: 'object',
      additionalProperties: false,
      required: ['query'],
      properties: {
        source: { type: 'object', description: '源图（同 browser_vision_image.source），默认 live。' },
        region: {
          type: 'object',
          description: '搜索 ROI（图像像素 integer Rect，必须完全在图内）；候选坐标仍相对完整源图。',
          properties: { x: { type: 'integer' }, y: { type: 'integer' }, width: { type: 'integer' }, height: { type: 'integer' } },
          required: ['x', 'y', 'width', 'height'],
        },
        query: { type: 'object', description: 'Query：method* + minArea?(1–16000000) + maxResults?(1–100)；color{color*:RGB,tolerance?} / components{background?,tolerance?} / edges{edgeThreshold?} / template{template*:Source(product|baseline),minScore?,stride?}。' },
      },
    },
    output: { schema: { type: 'object' }, render: (args, value) => text(value) },
    async execute(args, exec) {
      const runtime = exec.runtime;
      const provenance = t3Provenance(runtime, exec);
      const pins = [];
      const budget = t3NewBudget();
      const warnings = [];
      let resolved = null;
      try {
        const request = t3FindRequest(args && typeof args === 'object' ? args : {});
        const liveScale = runtime.view.scale;
        resolved = await t3ResolveSource(runtime, exec, request.source, 'source', pins, budget, liveScale);
        const image = resolved.image;
        const roi = request.region ? t3RectInside(request.region, image, 'region') : { x: 0, y: 0, width: image.width, height: image.height };
        const templateResolved = await t3TemplateImage(runtime, exec, request.query, pins, budget, liveScale);
        const found = await vision.findInImageAsync(image, request.query, {
          roi, templateImage: templateResolved ? templateResolved.image : null,
          ...t3AlgoOpts(budget, exec.signal),
        }, t3AlgoOpts(budget, exec.signal));
        const result = t3FindResult(request.query, found, image, resolved.product, resolved.product ? resolved.product.mapping : null, { ...roi });
        if (result.truncated) t3Warning(warnings, 'regions-truncated');
        const sourceEntries = templateResolved
          ? [t3EvidenceSource(resolved, 'source'), t3EvidenceSource(templateResolved, 'template')]
          : [t3EvidenceSource(resolved, 'source')];
        const evidence = t3BoundEvidence(t3Evidence({
          operation: 'find',
          provenance,
          source: sourceEntries,
          regions: result.candidates.map((candidate) => t3EvidenceRegion({
            id: candidate.id,
            role: 'candidate',
            imagePixels: candidate.region,
            beforeDocumentCss: candidate.documentCss,
            afterDocumentCss: null,
            area: candidate.area,
          })),
          metrics: {
            method: result.method,
            totalCandidates: result.totalCandidates,
            truncated: result.truncated,
            pixelComparisons: result.metrics ? result.metrics.pixelComparisons : null,
            foregroundPixels: result.metrics ? result.metrics.foregroundPixels : null,
            warnings,
          },
          verdict: { status: 'INCONCLUSIVE', reason: 'no-assertion' },
          incomplete: [],
        }));
        runtime.noteVisionOperation('find', 'INCONCLUSIVE');
        return { ok: true, source: resolved.product, result, evidence: { vision: evidence } };
      } catch (error) {
        const evidence = t3Evidence({
          operation: 'find',
          provenance,
          source: resolved ? [t3EvidenceSource(resolved, 'source')] : [],
          verdict: { status: 'BLOCKED', reason: 'error' },
          metrics: { errorCode: error && error.code ? error.code : 'INTERNAL', warnings },
          incomplete: ['operation-failed'],
        });
        runtime.noteVisionOperation('find', null);
        throw t3ThrowWithEvidence(error, evidence);
      } finally {
        t3ReleasePins(runtime, pins);
      }
    },
  });

  /* --- browser_vision_compare -------------------------------------------------------------- */
  register({
    name: 'browser_vision_compare',
    description: 'T3 静态视觉：对两张显式源图做 YIQ 像素差异比较（固定算法 t3-v1），输出完整尺寸的标注差异 PNG（红=差异、黄=AA、灰=mask、蓝=区域 bbox）与 PASS/WARN/FAIL。'
      + 'before/after 必须显式给出；两图必须同像素尺寸，否则 VISION_SIZE_MISMATCH；region 是两图共同的图像像素 Rect。'
      + 'masks 缺省继承 before 基线元数据（before 非基线则空），显式 [] 清空；options/thresholds 逐字段覆盖 before 基线默认。'
      + '全屏蔽无分母抛 VISION_EMPTY_COMPARISON，不返回 similarity=1；similarity 是阈值化差异覆盖率，不是语义相似度。'
      + '映射门禁：两图几何映射不兼容（不同目标/缩放/坐标空间）时 verdict=BLOCKED/mapping-incompatible，不再给 PASS；'
      + '只有显式 bitmapOnly=true 才降级为纯位图比较（标注 bitmap-only，不可当作几何验收）。',
    parameters: {
      type: 'object',
      additionalProperties: false,
      required: ['before', 'after'],
      properties: {
        before: { type: 'object', description: '比较前的源图（必填、显式）：Source。' },
        after: { type: 'object', description: '比较后的源图（必填、显式）：Source。' },
        region: {
          type: 'object',
          description: '比较 ROI（图像像素 integer Rect，两图都必须有效）；省略为全图。',
          properties: { x: { type: 'integer' }, y: { type: 'integer' }, width: { type: 'integer' }, height: { type: 'integer' } },
          required: ['x', 'y', 'width', 'height'],
        },
        masks: { type: 'array', description: 'Mask[]（最多 64、id 唯一）：{id,region:PixelRect}，坐标相对完整图。', items: { type: 'object' } },
        options: {
          type: 'object',
          description: 'DiffOptions：threshold 0–1（默认 0.1）、includeAA（默认 false）、minRegionPixels ≥1（默认 1）。',
          properties: { threshold: { type: 'number' }, includeAA: { type: 'boolean' }, minRegionPixels: { type: 'integer' } },
          required: [],
        },
        thresholds: {
          type: 'object',
          description: 'Thresholds：warnRatio/failRatio（0≤warn≤fail≤1，默认 0.001/0.01）。',
          properties: { warnRatio: { type: 'number' }, failRatio: { type: 'number' } },
          required: [],
        },
        bitmapOnly: {
          type: 'boolean',
          description: '显式选择"只比较位图、不参与几何验收"（默认 false）。false 时两图 mapping 不兼容会返回 BLOCKED/mapping-incompatible，'
            + '不再给 PASS；true 时只返回位图差异比率并标 bitmap-only，其结论不得当作几何验收证据。',
        },
        output: {
          type: 'object',
          description: '差异 PNG 的落盘选择（同 browser_vision_image.output）：默认暂存，out/persist:true/env 触发持久。',
          properties: { persist: { type: 'boolean' }, out: { type: 'string' } },
          required: [],
        },
      },
    },
    output: { schema: { type: 'object' }, render: (args, value) => {
      const { image, attachment, ...meta } = value;
      return attachment ? [{ type: 'image', attachment }, ...text(meta)] : text({ ...meta, image });
    } },
    async execute(args, exec) {
      const runtime = exec.runtime;
      const provenance = t3Provenance(runtime, exec);
      const pins = [];
      const budget = t3NewBudget();
      const warnings = [];
      let resolvedBefore = null;
      let resolvedAfter = null;
      try {
        const request = t3CompareRequest(args && typeof args === 'object' ? args : {});
        // Both live sources share ONE resolved default so two images of the same call cannot fall
        // on different densities if the view scale changes between resolutions.
        const liveScale = runtime.view.scale;
        resolvedBefore = await t3ResolveSource(runtime, exec, request.before, 'before', pins, budget, liveScale);
        resolvedAfter = await t3ResolveSource(runtime, exec, request.after, 'after', pins, budget, liveScale);
        const beforeImage = resolvedBefore.image;
        const afterImage = resolvedAfter.image;
        if (beforeImage.width !== afterImage.width || beforeImage.height !== afterImage.height) {
          throw new BrowserError('VISION_SIZE_MISMATCH', '比较的两张图必须像素尺寸相同（不自动 resize/align）', {
            before: { width: beforeImage.width, height: beforeImage.height },
            after: { width: afterImage.width, height: afterImage.height },
          });
        }
        const region = request.region ? t3RectInside(request.region, beforeImage, 'region') : { x: 0, y: 0, width: beforeImage.width, height: beforeImage.height };
        const baselineMeta = resolvedBefore.kind === 'baseline' ? resolvedBefore.baseline : null;
        let masks;
        if (request.masksProvided) masks = request.masks;
        else if (baselineMeta) masks = Array.isArray(baselineMeta.masks) ? baselineMeta.masks : [];
        else masks = [];
        t3ValidateMaskBounds(masks, beforeImage);
        let options = { ...T3_DEFAULT_DIFF_OPTIONS };
        if (baselineMeta && baselineMeta.options) options = { ...options, ...baselineMeta.options };
        options = t3MergeResolved(options, request.options, vision.validateDiffOptions, 'options');
        let thresholds = { ...T3_DEFAULT_THRESHOLDS };
        if (baselineMeta && baselineMeta.thresholds) thresholds = { ...thresholds, ...baselineMeta.thresholds };
        thresholds = t3MergeResolved(thresholds, request.thresholds, vision.validateThresholds, 'thresholds');
        if (!(thresholds.warnRatio <= thresholds.failRatio)) {
          throw t3Invalid('thresholds 必须满足 0 ≤ warnRatio ≤ failRatio ≤ 1', { path: 'thresholds' });
        }
        const diff = await vision.diffImagesAsync(beforeImage, afterImage, {
          region, masks, options, ...t3AlgoOpts(budget, exec.signal),
        }, t3AlgoOpts(budget, exec.signal));
        if (!diff || !diff.metrics || diff.metrics.comparedPixels === 0) {
          throw new BrowserError('VISION_EMPTY_COMPARISON', 'ROI 内所有像素都被 mask 排除，无法计算差异比例', {
            region, maskedPixels: diff && diff.metrics ? diff.metrics.maskedPixels : null,
          });
        }
        const verdict = t3RatioVerdict(diff.metrics.diffRatio, thresholds);
        const mappingCompatible = Boolean(
          resolvedBefore.product && resolvedBefore.product.mapping
          && resolvedAfter.product && resolvedAfter.product.mapping
          && vision.mappingCompatible(resolvedBefore.product.mapping, resolvedAfter.product.mapping),
        );
        const regionList = Array.isArray(diff.regions) ? diff.regions : [];
        const comparisonRegions = regionList.map((item) => {
          const imagePixels = item.imagePixels ?? item.region ?? null;
          return {
            id: item.id,
            area: item.area,
            imagePixels,
            beforeDocumentCss: mappingCompatible && imagePixels ? vision.mapImageRectToDocument(resolvedBefore.product.mapping, imagePixels) : null,
            afterDocumentCss: mappingCompatible && imagePixels ? vision.mapImageRectToDocument(resolvedAfter.product.mapping, imagePixels) : null,
          };
        });
        if (comparisonRegions.length > T3_EVIDENCE_REGIONS) t3Warning(warnings, 'regions-truncated');
        if (!mappingCompatible) t3Warning(warnings, 'mapping-incompatible');
        // Mapping gate (plan §4.5 / A03): a bitmap ratio over incompatible geometry is not an
        // acceptance signal. Without an explicit `bitmapOnly` opt-in the comparison is BLOCKED, so
        // "same pixels, different target region" can never come back as PASS.
        const bitmapOnly = request.bitmapOnly === true;
        const gatedVerdict = mappingCompatible ? verdict : (bitmapOnly ? verdict : 'BLOCKED');
        const gatedReason = mappingCompatible ? 'ratio' : (bitmapOnly ? 'bitmap-only' : 'mapping-incompatible');
        if (!mappingCompatible && bitmapOnly) t3Warning(warnings, 'advisory-only');
        const highlight = Buffer.isBuffer(diff.highlight) ? diff.highlight : Buffer.from(diff.highlight ?? []);
        const png = inspectPng(highlight, { checkCrc: true });
        if (!png.ok) throw new BrowserError('INVALID_PNG', '差异图未通过 PNG 结构/CRC 校验', { phase: 'inspectPng', reason: png.message });
        if (png.width !== beforeImage.width || png.height !== beforeImage.height) {
          throw new BrowserError('CAPTURE_SIZE_MISMATCH', '差异图尺寸必须等于完整源图尺寸', {
            actual: { width: png.width, height: png.height },
            expected: { width: beforeImage.width, height: beforeImage.height },
          });
        }
        const diffProduct = t3ProductPublic(t3AddProduct(runtime, {
          bytes: highlight, width: png.width, height: png.height, sha256: t3Sha256(highlight),
          rgbaSha256: null, kind: 'diff', mapping: null, actionable: false,
          parentIds: [resolvedBefore.product.productId, resolvedAfter.product.productId],
          operations: [{ op: 'diff', parameters: { resolvedOptions: options, resolvedThresholds: thresholds, resolvedMasks: masks } }],
          capturedAt: null, provenance,
        }));
        const delivered = await t3DeliverImage(runtime, exec, request.output, highlight, png.width, png.height, warnings);
        const comparison = {
          region,
          resolvedMasks: masks,
          resolvedOptions: options,
          resolvedThresholds: thresholds,
          metrics: diff.metrics,
          regions: comparisonRegions,
          regionCount: Number.isInteger(diff.regionCount) ? diff.regionCount : comparisonRegions.length,
          regionsTruncated: diff.regionsTruncated === true || comparisonRegions.length > T3_EVIDENCE_REGIONS,
          verdict: gatedVerdict,
          reason: gatedReason,
          ratioVerdict: verdict,
          bitmapOnly,
          mappingCompatible,
        };
        const metrics = {
          ...diff.metrics,
          warnings,
        };
        const evidence = t3BoundEvidence(t3Evidence({
          operation: 'compare',
          provenance,
          source: [t3EvidenceSource(resolvedBefore, 'before'), t3EvidenceSource(resolvedAfter, 'after')],
          regions: comparisonRegions.map((item) => t3EvidenceRegion({
            id: item.id, role: 'diff', imagePixels: item.imagePixels,
            beforeDocumentCss: item.beforeDocumentCss, afterDocumentCss: item.afterDocumentCss, area: item.area,
          })),
          metrics,
          verdict: { status: gatedVerdict, reason: gatedReason },
          output: { productId: diffProduct.productId, sha256: delivered.sha256, file: delivered.file, delivery: delivered.delivery },
          incomplete: comparison.regionsTruncated ? ['regions-truncated'] : [],
        }));
        runtime.noteVisionOperation('compare', gatedVerdict);
        return {
          ok: true,
          before: resolvedBefore.product,
          after: resolvedAfter.product,
          product: diffProduct,
          image: highlight.toString('base64'),
          bytes: highlight.length,
          sha256: delivered.sha256,
          attachment: delivered.attachment,
          attachmentId: delivered.attachmentId,
          imageDelivery: delivered.imageDelivery,
          attachmentError: delivered.attachmentError,
          file: delivered.file,
          comparison,
          evidence: { vision: evidence },
        };
      } catch (error) {
        const sources = [];
        if (resolvedBefore) sources.push(t3EvidenceSource(resolvedBefore, 'before'));
        if (resolvedAfter) sources.push(t3EvidenceSource(resolvedAfter, 'after'));
        const evidence = t3Evidence({
          operation: 'compare',
          provenance,
          source: sources,
          verdict: { status: 'BLOCKED', reason: 'error' },
          metrics: { errorCode: error && error.code ? error.code : 'INTERNAL', warnings },
          incomplete: ['operation-failed'],
        });
        runtime.noteVisionOperation('compare', null);
        throw t3ThrowWithEvidence(error, evidence);
      } finally {
        t3ReleasePins(runtime, pins);
      }
    },
  });


  /* --- browser_vision_act ------------------------------------------------------------------ */
  const T3_MOUSE_BUTTON_BITS = Object.freeze({ left: 1, right: 2, middle: 4 });
  function t3MouseMask(button) {
    return T3_MOUSE_BUTTON_BITS[button] || 1;
  }
  function t3ModifierMask(modifiers) {
    return (modifiers || []).reduce((mask, name) => mask | (MODIFIER_BITS[name] || 0), 0);
  }

  /**
   * Hit-test one *document CSS* point (§6 step 4).
   *
   * `DOM.getNodeForLocation` takes frame-view (document) coordinates and integer values: passing a
   * viewport point or a fraction is rejected by the protocol ("Invalid parameters"). Only the hit
   * test is quantised — the dispatched Input events keep the continuous viewport coordinates.
   * CDP reports "no node at location" as an error, which is simply "no hit".
   */
  async function t3HitNode(runtime, signal, documentPoint) {
    try {
      const hit = await runtime.send('DOM.getNodeForLocation', {
        x: Math.floor(documentPoint.x),
        y: Math.floor(documentPoint.y),
        includeUserAgentShadowDOM: true,
        ignorePointerEventsNone: false,
      }, signal);
      if (!hit || !Number.isInteger(hit.backendNodeId)) return null;
      return hit;
    } catch (error) {
      if (error && error.code === 'ABORTED') throw error;
      return null;
    }
  }

  /** Live node facts for the hit node: connected / disabled / inert / bbox (CSS px). */
  async function t3NodeFacts(runtime, signal, backendNodeId) {
    let objectId = null;
    try {
      const resolved = await runtime.send('DOM.resolveNode', { backendNodeId }, signal);
      objectId = resolved && resolved.object ? resolved.object.objectId : null;
    } catch {
      objectId = null;
    }
    if (!objectId) return { connected: false, disabled: false, inert: false, rect: null };
    try {
      const evaluated = await runtime.send('Runtime.callFunctionOn', {
        objectId,
        functionDeclaration: 'function () {'
          + ' var el = this;'
          + ' if (!el || el.isConnected !== true) return { connected: false, disabled: false, inert: false, rect: null };'
          + ' var rect = el.getBoundingClientRect();'
          // Walk the composed ancestor chain (crossing shadow hosts): an inert *ancestor* makes the
          // subtree non-interactive even though `el.inert` itself is false.
          + ' var inert = false;'
          + ' var node = el;'
          + ' while (node && node.nodeType === 1) {'
          + ' if (node.inert === true || node.hasAttribute("inert")) { inert = true; break; }'
          + ' if (node.parentElement) { node = node.parentElement; continue; }'
          + ' var root = typeof node.getRootNode === "function" ? node.getRootNode() : null;'
          + ' node = root && root.host ? root.host : null;'
          + ' }'
          + ' var disabled = el.disabled === true || el.getAttribute("aria-disabled") === "true";'
          + ' return { connected: true, disabled: disabled, inert: inert,'
          + ' rect: { x: rect.x, y: rect.y, width: rect.width, height: rect.height } };'
          + ' }',
        returnByValue: true,
      }, signal);
      const value = evaluated && evaluated.result ? evaluated.result.value : null;
      if (!value || typeof value !== 'object') return { connected: false, disabled: false, inert: false, rect: null };
      return {
        connected: value.connected === true,
        disabled: value.disabled === true,
        inert: value.inert === true,
        rect: value.rect && Number.isFinite(value.rect.x) && Number.isFinite(value.rect.y)
          ? { x: value.rect.x, y: value.rect.y, width: value.rect.width, height: value.rect.height }
          : null,
      };
    } catch (error) {
      if (error && error.code === 'ABORTED') throw error;
      return { connected: false, disabled: false, inert: false, rect: null };
    }
  }

  /** Wait two animation frames (bounded); a throttled page falls back to a bounded timer. */
  async function t3NextFrames(runtime, signal) {
    try {
      // Direct CDP send: the bounded 1000ms budget must not be the 30s tool envelope.
      await runtime.cdp.send('Runtime.evaluate', {
        expression: 'new Promise(function (resolve) { requestAnimationFrame(function () { requestAnimationFrame(function () { resolve(1); }); }); })',
        awaitPromise: true,
        returnByValue: true,
      }, { signal, timeoutMs: 1000 });
    } catch (error) {
      if (error && error.code === 'ABORTED') throw error;
      await delay(32);
    }
  }
  function t3RectClose(a, b, tolerance = 1) {
    if (!a || !b) return false;
    return Math.abs(a.x - b.x) <= tolerance && Math.abs(a.y - b.y) <= tolerance
      && Math.abs(a.width - b.width) <= tolerance && Math.abs(a.height - b.height) <= tolerance;
  }

  /**
   * §6 step 4: hit identity + node state + two-frame stability. Returns the proven hit.
   * Zero dispatch on every failure path; the caller never searches for another point.
   */
  async function t3StableHit(runtime, signal, documentPoint) {
    const startedAt = Date.now();
    const first = await t3HitNode(runtime, signal, documentPoint);
    if (!first) {
      throw new BrowserError('VISION_HIT_MISMATCH', '该坐标没有可证明的命中节点（零派发）', { reason: 'no-hit' });
    }
    if (runtime.mainFrameId && first.frameId && first.frameId !== runtime.mainFrameId) {
      throw new BrowserError('UNSUPPORTED', '跨 frame 命中无法证明主 frame 归属（零派发）', { reason: 'cross-frame-hit' });
    }
    const firstFacts = await t3NodeFacts(runtime, signal, first.backendNodeId);
    if (!firstFacts.connected) {
      throw new BrowserError('VISION_HIT_MISMATCH', '命中节点未连接（零派发）', { reason: 'not-connected' });
    }
    if (firstFacts.disabled) {
      throw new BrowserError('VISION_HIT_MISMATCH', '命中节点 disabled（零派发）', { reason: 'disabled' });
    }
    if (firstFacts.inert) {
      throw new BrowserError('VISION_HIT_MISMATCH', '命中节点 inert（零派发）', { reason: 'inert' });
    }
    let previous = { backendNodeId: first.backendNodeId, rect: firstFacts.rect };
    for (let round = 0; round < 2; round += 1) {
      if (Date.now() - startedAt > 1000) {
        throw new BrowserError('VISION_HIT_MISMATCH', '命中在两帧内未稳定（零派发）', { reason: 'unstable-timeout' });
      }
      await t3NextFrames(runtime, signal);
      const hit = await t3HitNode(runtime, signal, documentPoint);
      if (!hit || hit.backendNodeId !== previous.backendNodeId) {
        throw new BrowserError('VISION_HIT_MISMATCH', '两帧命中的 backend 节点不同（零派发）', { reason: 'hit-identity-changed' });
      }
      const facts = await t3NodeFacts(runtime, signal, hit.backendNodeId);
      if (!facts.connected) {
        throw new BrowserError('VISION_HIT_MISMATCH', '命中节点在两帧间断开（零派发）', { reason: 'not-connected' });
      }
      if (!t3RectClose(previous.rect, facts.rect, 1)) {
        throw new BrowserError('VISION_HIT_MISMATCH', '命中节点 bbox 持续变化（零派发）', { reason: 'hit-rect-unstable' });
      }
      previous = { backendNodeId: hit.backendNodeId, rect: facts.rect };
    }
    return previous;
  }

  /** §6 step 5: real CDP Input dispatch (never DOM click/dispatchEvent). */
  async function t3DispatchMouse(runtime, signal, request, start, end) {
    const modifiers = t3ModifierMask(request.modifiers);
    const button = request.button;
    const buttonBit = t3MouseMask(button);
    let eventCount = 0;
    let started = false;
    let completed = false;
    let pressed = false;
    const send = async (type, x, y, extra) => {
      await runtime.send('Input.dispatchMouseEvent', { type, x, y, modifiers, ...extra }, signal);
      eventCount += 1;
    };
    try {
      if (request.action === 'move') {
        started = true;
        await send('mouseMoved', start.x, start.y, { button: 'none', buttons: 0 });
        completed = true;
      } else if (request.action === 'click') {
        started = true;
        await send('mouseMoved', start.x, start.y, { button: 'none', buttons: 0 });
        for (let count = 1; count <= request.clickCount; count += 1) {
          await send('mousePressed', start.x, start.y, { button, buttons: buttonBit, clickCount: count });
          pressed = true;
          await send('mouseReleased', start.x, start.y, { button, buttons: 0, clickCount: count });
          pressed = false;
        }
        completed = true;
      } else {
        started = true;
        await send('mouseMoved', start.x, start.y, { button: 'none', buttons: 0 });
        await send('mousePressed', start.x, start.y, { button, buttons: buttonBit, clickCount: 1 });
        pressed = true;
        const perStep = request.steps > 0 ? request.durationMs / request.steps : 0;
        for (let step = 1; step <= request.steps; step += 1) {
          const ratio = step / request.steps;
          const x = start.x + (end.x - start.x) * ratio;
          const y = start.y + (end.y - start.y) * ratio;
          if (perStep > 0) await delay(perStep);
          await send('mouseMoved', x, y, { button, buttons: buttonBit });
        }
        await send('mouseReleased', end.x, end.y, { button, buttons: 0, clickCount: 1 });
        pressed = false;
        completed = true;
      }
    } finally {
      if (pressed) {
        // Best effort: a partially dispatched drag still releases the pressed button.
        try {
          await runtime.cdp.send('Input.dispatchMouseEvent', {
            type: 'mouseReleased', x: start.x, y: start.y, button, buttons: 0, clickCount: 1, modifiers,
          }, { signal, timeoutMs: 1000 });
          eventCount += 1;
          pressed = false;
        } catch { /* the abort/disconnect path must not hang here */ }
      }
    }
    return { eventCount, started, completed, released: !pressed };
  }

  /** Evidence source entry for a pinned product (act/baseline/check reuse this projection). */
  function t3ProductSourceEntry(product, role) {
    return {
      role,
      kind: product && product.kind === 'baseline' ? 'baseline' : product && product.kind === 'capture' ? 'product' : 'product',
      productId: product ? product.productId : null,
      sha256: product ? product.sha256 : null,
      width: product ? product.width : null,
      height: product ? product.height : null,
      capturedAt: product ? product.capturedAt : null,
      mapping: product ? product.mapping : null,
      capture: null,
    };
  }

  register({
    name: 'browser_vision_act',
    description: 'T3 静态视觉：用当前截图里的坐标派发真实鼠标输入（move/click/drag）。'
      + 'productId 必须来自本工作区、capture 年龄 ≤30s、同 runtime/pageGeneration/documentEpoch 且可操作（仅 capture 或 crop+nearest derived）。'
      + '派发前依次：现场 layout/scroll/visualViewport 复验 → 同矩形重采样并比对原始 RGBA hash → 视口校验 → DOM.getNodeForLocation 命中 + connected/disabled/inert + 两帧稳定 → CDP Input 真实派发（finally 释放按键）→ 输入后单次 after product。'
      + '任何一步不满足都零派发：VISION_STALE_IMAGE / VISION_HIT_MISMATCH / NOT_INTERACTABLE(outside-viewport)。'
      + 'dispatched=true 只表示输入已派发，不代表点中业务目标或任何视觉断言通过；本工具 verdict 固定 INCONCLUSIVE(dispatch-only)。',
    parameters: {
      type: 'object',
      additionalProperties: false,
      required: ['productId', 'action', 'point'],
      properties: {
        productId: { type: 'string', description: '来自本工作区 store 的 productId（^v1_[0-9a-f]{32}$）。' },
        action: { type: 'string', enum: ['move', 'click', 'drag'], description: '动作类型。' },
        point: { type: 'object', description: '图像连续像素坐标 {x,y}（不自动加 0.5、不取整）；像素中心请传 i+0.5。', properties: { x: { type: 'number' }, y: { type: 'number' } }, required: ['x', 'y'] },
        to: { type: 'object', description: 'drag 终点（其他 action 禁止）；同样为图像连续像素坐标。', properties: { x: { type: 'number' }, y: { type: 'number' } }, required: ['x', 'y'] },
        button: { type: 'string', enum: ['left', 'right', 'middle'], description: '鼠标键（只对 click/drag，默认 left）。' },
        clickCount: { type: 'integer', description: '只对 click，1–2，默认 1。' },
        modifiers: { type: 'array', items: { type: 'string', enum: ['alt', 'ctrl', 'meta', 'shift'] }, description: '修饰键 alt/ctrl/meta/shift（不重复，最多 4 项）。' },
        steps: { type: 'integer', description: '只对 drag，1–100，默认 20（线性路径，事件数 steps+3）。' },
        durationMs: { type: 'integer', description: '只对 drag，0–2000，默认 500（均分到移动步之间）。' },
      },
    },
    output: { schema: { type: 'object' }, render: (args, value) => text(value) },
    async execute(args, exec) {
      const runtime = exec.runtime;
      const provenance = t3Provenance(runtime, exec);
      const pins = [];
      const warnings = [];
      const incomplete = [];
      const dispatchState = { started: false, eventCount: 0, completed: false, eventSource: 'cdp-input', hitBackendNodeId: null, released: true };
      let product = null;
      let request = null;
      try {
        request = t3ActRequest(args && typeof args === 'object' ? args : {});
        const entry = runtime.visionProducts.pin(request.productId);
        if (!entry) {
          throw new BrowserError('VISION_SOURCE_NOT_FOUND', 'product 不存在、已淘汰或不属于本工作区', { productId: request.productId });
        }
        pins.push(request.productId);
        product = t3ProductPublic(entry);
        const stored = runtime.visionProvenance.get(request.productId) || null;
        const captureFacts = stored && stored.capture ? stored.capture : null;
        const ageMs = product.capturedAt === null ? null : Date.now() - product.capturedAt;
        if (!product.actionable || product.mapping === null || captureFacts === null) {
          throw new BrowserError('VISION_STALE_IMAGE', 'product 不可操作（基线/差异/预处理/标注或缺少采集映射）', {
            reason: 'not-actionable', actionable: product.actionable, mapping: product.mapping !== null,
          });
        }
        if (ageMs === null || ageMs > T3_ACT_MAX_AGE_MS) {
          throw new BrowserError('VISION_STALE_IMAGE', 'product 的采集时间超过 30s 或未知', {
            reason: 'stale-age', ageMs, maxAgeMs: T3_ACT_MAX_AGE_MS,
          });
        }
        // Same runtime / page generation / document epoch.
        if (!stored || stored.runtimeId !== runtime.runtimeId
          || stored.pageGeneration !== runtime.pageGeneration()
          || stored.documentEpoch !== runtime.documentEpoch()) {
          throw new BrowserError('VISION_STALE_IMAGE', '页面代次或文档代次已变化（截图与现场不是同一页面）', {
            reason: 'generation-changed',
            pageGeneration: runtime.pageGeneration(),
            documentEpoch: runtime.documentEpoch(),
          });
        }
        // §6 step 1: live layout/scroll/viewport/zoom re-check (no auto scroll or zoom).
        const live = await runtime.layoutMetrics(exec.signal);
        const mapping = product.mapping;
        const scrollCaptured = mapping.scrollAtCapture || { x: 0, y: 0 };
        const viewportCaptured = mapping.viewportAtCapture || { width: 0, height: 0 };
        const stale = [];
        if (Math.abs(live.scroll.x - scrollCaptured.x) > 0.01 || Math.abs(live.scroll.y - scrollCaptured.y) > 0.01) stale.push('scroll-changed');
        if (Math.abs(live.viewport.width - viewportCaptured.width) > 0.01
          || Math.abs(live.viewport.height - viewportCaptured.height) > 0.01) stale.push('viewport-changed');
        if (live.visualViewportScale !== 1) stale.push('visual-viewport-scale');
        if (mapping.visualViewportScale !== null && live.visualViewportScale !== null
          && Math.abs(mapping.visualViewportScale - live.visualViewportScale) > 1e-9) stale.push('visual-viewport-scale-changed');
        if (stale.length) {
          throw new BrowserError('VISION_STALE_IMAGE', '现场 scroll/viewport/zoom 与截图采集时不同（零派发）', {
            reason: stale[0], differences: stale,
          });
        }
        if (mapping.visualViewportScale === null) incomplete.push('visual-viewport-scale-unknown');
        // §6 step 2: re-capture the ancestor capture rect/scale and compare decoded RGBA hashes.
        const recapture = await p0(exec, 'A', 'capture', { scale: captureFacts.scale, region: captureFacts.region });
        const recapturePng = inspectPng(recapture.pngBytes, { checkCrc: true });
        if (!recapturePng.ok) {
          throw new BrowserError('INVALID_PNG', '复验截图不是结构完整的 PNG', { phase: 'inspectPng', reason: recapturePng.message });
        }
        const recaptureDecoded = await t3Decode(recapture.pngBytes, exec.signal, t3NewBudget());
        const recaptureHash = t3RgbaSha256(recaptureDecoded.rgba);
        if (captureFacts.rgbaSha256 && recaptureHash !== captureFacts.rgbaSha256) {
          throw new BrowserError('VISION_STALE_IMAGE', '重新截图与原始 capture 像素不一致（页面已变化，零派发）', {
            reason: 'pixels-changed', captureSha256: captureFacts.sha256 ?? null, recaptureSha256: t3Sha256(recapture.pngBytes),
          });
        }
        // §6 step 3: image → document → viewport, then inside-viewport check.
        const documentPoint = vision.mapImagePointToDocument(mapping, request.point);
        if (!documentPoint) {
          throw new BrowserError('VISION_STALE_IMAGE', 'point 无法按 mapping 映射到文档坐标（零派发）', { reason: 'mapping-unavailable' });
        }
        const toViewport = (documentCss) => ({ x: documentCss.x - live.scroll.x, y: documentCss.y - live.scroll.y });
        const viewportPoint = toViewport(documentPoint);
        let viewportTo = null;
        let documentTo = null;
        if (request.action === 'drag') {
          documentTo = vision.mapImagePointToDocument(mapping, request.to);
          if (!documentTo) {
            throw new BrowserError('VISION_STALE_IMAGE', 'to 无法按 mapping 映射到文档坐标（零派发）', { reason: 'mapping-unavailable' });
          }
          viewportTo = toViewport(documentTo);
        }
        // §6.2: blank canvas has no page content — zero dispatch with an explicit reason. Canvas ==
        // document, so a point outside the content box is blank; a point outside the captured image
        // does not exist in this product at all.
        const imagePixels = mapping.imagePixels && Number.isFinite(mapping.imagePixels.width)
          ? mapping.imagePixels : null;
        const contentSize = mapping.canvas && Number.isFinite(mapping.canvas.contentWidth)
          && Number.isFinite(mapping.canvas.contentHeight)
          ? { width: mapping.canvas.contentWidth, height: mapping.canvas.contentHeight }
          : null;
        const canvasSpace = mapping.coordinateSpace === 'canvas-css-px';
        const blankReason = (documentCss, imagePoint) => {
          if (!canvasSpace || !contentSize) return null;
          if (imagePixels && (imagePoint.x < 0 || imagePoint.y < 0
            || imagePoint.x > imagePixels.width || imagePoint.y > imagePixels.height)) return 'outside-image';
          if (documentCss.x < 0 || documentCss.y < 0
            || documentCss.x >= contentSize.width || documentCss.y >= contentSize.height) return 'blank-area';
          return null;
        };
        const startBlank = blankReason(documentPoint, request.point);
        if (startBlank) {
          throw new BrowserError('VISION_HIT_MISMATCH', '画布空白区没有页面内容（零派发）', {
            reason: startBlank,
            canvasPoint: { x: documentPoint.x, y: documentPoint.y },
            imagePoint: request.point,
            content: contentSize,
            canvas: mapping.canvas ? {
              x: mapping.canvas.x, y: mapping.canvas.y,
              offsetX: mapping.canvas.offsetX, offsetY: mapping.canvas.offsetY,
            } : null,
          });
        }
        const endBlank = request.action === 'drag' ? blankReason(documentTo, request.to) : null;
        if (endBlank) {
          throw new BrowserError('VISION_HIT_MISMATCH', 'drag 终点在画布空白区（零派发）', {
            reason: endBlank,
            canvasPoint: { x: documentTo.x, y: documentTo.y },
            imagePoint: request.to,
            content: contentSize,
          });
        }
        const insideViewport = (p) => p.x >= 0 && p.y >= 0 && p.x <= live.viewport.width && p.y <= live.viewport.height;
        if (!insideViewport(viewportPoint)) {
          throw new BrowserError('NOT_INTERACTABLE', '起点不在当前视口内（零派发，不自动滚动）', { reason: 'outside-viewport' });
        }
        if (viewportTo && !insideViewport(viewportTo)) {
          throw new BrowserError('NOT_INTERACTABLE', 'drag 终点不在当前视口内（零派发，不自动滚动）', { reason: 'outside-viewport' });
        }
        if (viewportTo) {
          for (let step = 1; step <= request.steps; step += 1) {
            const ratio = step / request.steps;
            const x = viewportPoint.x + (viewportTo.x - viewportPoint.x) * ratio;
            const y = viewportPoint.y + (viewportTo.y - viewportPoint.y) * ratio;
            if (!insideViewport({ x, y })) {
              throw new BrowserError('NOT_INTERACTABLE', 'drag 路径离开当前视口（零派发）', { reason: 'outside-viewport' });
            }
            // The page-viewport path must also stay on content (blank path → zero dispatch).
            const pathBlank = blankReason({ x: x + live.scroll.x, y: y + live.scroll.y }, { x: 0, y: 0 });
            if (pathBlank === 'blank-area') {
              throw new BrowserError('VISION_HIT_MISMATCH', 'drag 路径穿过画布空白区（零派发）', { reason: 'blank-area' });
            }
          }
        }
        // §6 step 4: hit identity + node state + two-frame stability. The hit test runs on the
        // integer document point; the dispatch below keeps the continuous viewport point.
        const hitDocument = { x: Math.floor(documentPoint.x), y: Math.floor(documentPoint.y) };
        const proven = await t3StableHit(runtime, exec.signal, hitDocument);
        dispatchState.hitBackendNodeId = proven.backendNodeId;
        // Input 前再次复验 page 代次、document 代次、scroll 与起点命中。
        if (stored.pageGeneration !== runtime.pageGeneration() || stored.documentEpoch !== runtime.documentEpoch()) {
          throw new BrowserError('VISION_STALE_IMAGE', '命中校验期间页面代次变化（零派发）', { reason: 'generation-changed' });
        }
        const liveAgain = await runtime.layoutMetrics(exec.signal);
        if (Math.abs(liveAgain.scroll.x - live.scroll.x) > 0.01 || Math.abs(liveAgain.scroll.y - live.scroll.y) > 0.01) {
          throw new BrowserError('VISION_STALE_IMAGE', '命中校验期间 scroll 变化（零派发）', { reason: 'scroll-changed' });
        }
        const hitAgain = await t3HitNode(runtime, exec.signal, hitDocument);
        if (!hitAgain || hitAgain.backendNodeId !== proven.backendNodeId) {
          throw new BrowserError('VISION_HIT_MISMATCH', '输入前命中身份变化（零派发）', { reason: 'hit-identity-changed' });
        }
        // §6 step 5: real CDP Input dispatch (finally releases the pressed button).
        const dispatched = await t3DispatchMouse(runtime, exec.signal, request, viewportPoint, viewportTo);
        dispatchState.started = dispatched.started;
        dispatchState.eventCount = dispatched.eventCount;
        dispatchState.completed = dispatched.completed;
        dispatchState.released = dispatched.released;
        // §6 step 6: one immediate after-capture of the same rect/scale (no file/base64).
        let afterProduct = null;
        try {
          const after = await p0(exec, 'A', 'capture', { scale: captureFacts.scale, region: captureFacts.region });
          const afterPng = inspectPng(after.pngBytes, { checkCrc: true });
          if (!afterPng.ok) throw new Error('after PNG invalid');
          const afterDecoded = await t3Decode(after.pngBytes, exec.signal, t3NewBudget());
          const afterMapping = t3CaptureMapping(after.capture, afterDecoded.width, afterDecoded.height);
          afterProduct = t3ProductPublic(t3AddProduct(runtime, {
            bytes: after.pngBytes, width: afterDecoded.width, height: afterDecoded.height,
            sha256: t3Sha256(after.pngBytes), rgbaSha256: t3RgbaSha256(afterDecoded.rgba),
            kind: 'capture', mapping: afterMapping, actionable: true, parentIds: [], operations: [],
            capturedAt: after.capture.capturedAt,
            provenance: { ...t3Provenance(runtime, exec), capture: {
              region: after.capture.region, scale: after.capture.requestedScale,
              scroll: after.capture.scroll, viewport: after.capture.viewport,
              visualViewportScale: after.capture.visualViewportScale ?? null,
              capturedAt: after.capture.capturedAt, sha256: t3Sha256(after.pngBytes),
              rgbaSha256: t3RgbaSha256(afterDecoded.rgba),
            } },
          }));
        } catch (error) {
          if (error && error.code === 'ABORTED') throw error;
          incomplete.push('after-capture-failed');
        }
        const metrics = {
          ageMs,
          imagePixels: request.point,
          documentCss: documentPoint,
          viewportCss: viewportPoint,
          released: dispatchState.released,
          hitBackendNodeId: dispatchState.hitBackendNodeId,
          warnings,
        };
        const evidence = t3BoundEvidence(t3Evidence({
          operation: 'act',
          provenance,
          source: [t3ProductSourceEntry(product, 'source')],
          regions: [],
          metrics,
          verdict: { status: 'INCONCLUSIVE', reason: 'dispatch-only' },
          dispatch: {
            started: dispatchState.started, eventCount: dispatchState.eventCount,
            completed: dispatchState.completed, eventSource: 'cdp-input',
            hitBackendNodeId: dispatchState.hitBackendNodeId,
          },
          output: { productId: afterProduct ? afterProduct.productId : null, sha256: null, file: null, delivery: null },
          incomplete,
        }));
        runtime.noteVisionOperation('act', 'INCONCLUSIVE');
        const pointOut = {
          imagePixels: request.point,
          documentCss: documentPoint,
          viewportCss: viewportPoint,
        };
        const toOut = viewportTo ? { imagePixels: request.to, documentCss: documentTo, viewportCss: viewportTo } : null;
        return {
          ok: true,
          dispatched: dispatchState.started && dispatchState.completed,
          action: request.action,
          point: pointOut,
          to: toOut,
          dispatch: {
            eventCount: dispatchState.eventCount,
            completed: dispatchState.completed,
            eventSource: 'cdp-input',
            released: dispatchState.released,
          },
          beforeProductId: request.productId,
          afterProduct,
          evidence: { vision: evidence },
        };
      } catch (error) {
        const motion = error && error.code === 'VISION_HIT_MISMATCH'
          && error.details && error.details.reason === 'hit-rect-unstable';
        const evidence = t3Evidence({
          operation: 'act',
          provenance,
          source: product ? [t3ProductSourceEntry(product, 'source')] : [],
          verdict: { status: 'BLOCKED', reason: 'error' },
          escalation: motion ? { tier: 'T4', reason: 'target-in-motion' } : null,
          metrics: {
            errorCode: error && error.code ? error.code : 'INTERNAL',
            released: dispatchState.released,
            warnings,
          },
          dispatch: {
            started: dispatchState.started, eventCount: dispatchState.eventCount,
            completed: dispatchState.completed, eventSource: dispatchState.started ? 'cdp-input' : null,
            hitBackendNodeId: dispatchState.hitBackendNodeId,
          },
          incomplete: [...incomplete, 'operation-failed'],
        });
        runtime.noteVisionOperation('act', null);
        throw t3ThrowWithEvidence(error, evidence);
      } finally {
        t3ReleasePins(runtime, pins);
      }
    },
  });


  /* --- browser_vision_baseline -------------------------------------------------------------- */

  /** BaselineMeta projection for evidence (§3.2 `baseline[]`). */
  function t3BaselineEvidenceEntry(meta) {
    return {
      name: meta && typeof meta.name === 'string' ? meta.name : null,
      revision: meta && Number.isInteger(meta.revision) ? meta.revision : null,
      headToken: meta && typeof meta.headToken === 'string' ? meta.headToken : null,
      tombstone: Boolean(meta && meta.tombstone === true),
    };
  }

  /** `store.get` returns `{ok,meta,pngBytes}`; tolerate a bare BaselineMeta too. */
  function t3BaselineGetResult(got) {
    if (!got || typeof got !== 'object') return { meta: null, pngBytes: null };
    if (got.meta && typeof got.meta === 'object') return { meta: got.meta, pngBytes: got.pngBytes ?? null };
    return { meta: got, pngBytes: got.pngBytes ?? null };
  }

  register({
    name: 'browser_vision_baseline',
    description: 'T3 静态视觉基线（受管、不可变 revision + HEAD CAS 提交）：action=list/get/create/update/delete。'
      + 'root 沿用 P0 持久根规则（DSH_UI_TESTING_CAPTURE_DIR 优先，否则可信 exec cwd），按 scopeHash 隔离；目录 0700、文件 0600，仅 create/update 建目录，list/get/delete 只读。'
      + 'create 一次调用完成采集+PNG+元数据+HEAD 提交（不覆盖已用名字，含墓碑）；update/delete 必须给 expectedRevision（CAS，不等报 VISION_BASELINE_CONFLICT）；delete 是逻辑墓碑，不删不可变 PNG。'
      + 'source 禁止指向正在创建/更新的同名 HEAD（避免隐式自更新）。离线 list/get/delete 不启动 Chromium。',
    parameters: {
      type: 'object',
      additionalProperties: false,
      required: ['action'],
      properties: {
        action: { type: 'string', enum: ['list', 'get', 'create', 'update', 'delete'], description: '基线操作。' },
        name: { type: 'string', description: '基线名（^[a-zA-Z0-9][a-zA-Z0-9_-]{0,63}$，大小写敏感）。' },
        revision: { type: 'integer', description: 'get 可选：读取指定不可变 revision（省略为逻辑 HEAD）。' },
        source: { type: 'object', description: 'create/update 的源图（Source）；create 必填。' },
        expectedRevision: { type: 'integer', description: 'update/delete 必填：CAS 期望的当前 HEAD revision。' },
        caseId: { type: 'string', description: 'create 默认等于 name；update 缺省继承旧值。' },
        options: { type: 'object', description: 'DiffOptions（create 默认契约默认值；update 缺省继承/逐字段合并）。' },
        thresholds: { type: 'object', description: 'Thresholds（同上）。' },
        masks: { type: 'array', description: 'Mask[]（create 默认 []；update 缺省继承，显式 [] 清空）。', items: { type: 'object' } },
      },
    },
    output: { schema: { type: 'object' }, render: (args, value) => text(value) },
    async execute(args, exec) {
      const runtime = exec.runtime;
      const provenance = t3Provenance(runtime, exec);
      const pins = [];
      const warnings = [];
      let request = null;
      let resolved = null;
      let meta = null;
      try {
        request = t3BaselineRequest(args && typeof args === 'object' ? args : {});
        const store = t3BaselineStore(runtime, exec);
        if (request.action === 'list') {
          const listed = store.list();
          if (!listed || listed.ok !== true) {
            throw new BrowserError('VISION_BASELINE_READ_FAILED', '基线列表读取失败', { reason: 'io' });
          }
          const baselines = Array.isArray(listed.baselines) ? listed.baselines : [];
          const evidence = t3BoundEvidence(t3Evidence({
            operation: 'baseline',
            provenance,
            source: [],
            baseline: baselines.map(t3BaselineEvidenceEntry),
            metrics: { action: 'list', count: baselines.length, warnings },
            verdict: { status: 'INCONCLUSIVE', reason: 'baseline-management' },
            incomplete: [],
          }));
          runtime.noteVisionOperation('baseline', 'INCONCLUSIVE');
          return { ok: true, action: 'list', baselines, provenance, evidence: { vision: evidence } };
        }
        if (request.action === 'get') {
          const got = request.revision === null
            ? store.get(request.name)
            : store.get(request.name, request.revision);
          const result = t3BaselineGetResult(got);
          if (!result.meta) throw new BrowserError('VISION_BASELINE_READ_FAILED', '基线元数据不可读', { reason: 'corrupt', name: request.name });
          meta = result.meta;
          let product = null;
          if (result.pngBytes) {
            const bytes = Buffer.isBuffer(result.pngBytes) ? result.pngBytes : Buffer.from(result.pngBytes);
            const decoded = await t3Decode(bytes, exec.signal, t3NewBudget());
            product = t3ProductPublic(t3AddProduct(runtime, {
              bytes, width: decoded.width, height: decoded.height, sha256: t3Sha256(bytes),
              rgbaSha256: t3RgbaSha256(decoded.rgba), kind: 'baseline', mapping: meta.mapping ?? null,
              actionable: false, parentIds: [], operations: [], capturedAt: null, provenance,
            }));
          }
          const evidence = t3BoundEvidence(t3Evidence({
            operation: 'baseline',
            provenance,
            source: product ? [t3ProductSourceEntry(product, 'source')] : [],
            baseline: [t3BaselineEvidenceEntry(meta)],
            metrics: { action: 'get', revision: meta.revision, tombstone: meta.tombstone === true, warnings },
            verdict: { status: 'INCONCLUSIVE', reason: 'baseline-management' },
            output: { productId: product ? product.productId : null, sha256: product ? product.sha256 : null, file: null, delivery: null },
            incomplete: product ? [] : ['tombstone-revision'],
          }));
          runtime.noteVisionOperation('baseline', 'INCONCLUSIVE');
          return { ok: true, action: 'get', baseline: meta, product, provenance, evidence: { vision: evidence } };
        }
        if (request.action === 'delete') {
          const deleted = store.delete({
            name: request.name,
            actionId: exec.meta.actionId,
            expectedRevision: request.expectedRevision,
          });
          meta = deleted && deleted.meta ? deleted.meta : deleted;
          const evidence = t3BoundEvidence(t3Evidence({
            operation: 'baseline',
            provenance,
            source: [],
            baseline: [t3BaselineEvidenceEntry(meta)],
            metrics: { action: 'delete', revision: meta && meta.revision, warnings },
            verdict: { status: 'INCONCLUSIVE', reason: 'baseline-management' },
            incomplete: [],
          }));
          runtime.noteVisionOperation('baseline', 'INCONCLUSIVE');
          return { ok: true, action: 'delete', baseline: meta, provenance, evidence: { vision: evidence } };
        }
        // create / update: resolve the source (live capture or product/baseline) exactly once.
        const sameNameHead = request.source.kind === 'baseline'
          && request.source.name === request.name
          && (request.source.revision === undefined || request.source.revision === null
            || (request.action === 'update' && request.source.revision === request.expectedRevision));
        if (sameNameHead) {
          throw t3Invalid('source 不能指向正在创建/更新的同名 HEAD（避免隐式自更新）', { path: 'source' });
        }
        resolved = await t3ResolveSource(runtime, exec, request.source, 'source', pins, t3NewBudget(), runtime.view.scale);
        const sourceSummary = {
          productId: resolved.product.productId,
          sha256: resolved.sha256,
          capturedAt: resolved.product.capturedAt,
          runtimeId: provenance.runtimeId,
          pageGeneration: provenance.pageGeneration,
          documentEpoch: provenance.documentEpoch,
        };
        const payload = {
          name: request.name,
          actionId: exec.meta.actionId,
          pngBytes: resolved.bytes,
          mapping: resolved.product.mapping ?? null,
          source: sourceSummary,
        };
        if (request.action === 'create') {
          payload.caseId = request.caseId === null ? request.name : request.caseId;
          payload.options = request.options ?? { ...T3_DEFAULT_DIFF_OPTIONS };
          payload.thresholds = request.thresholds ?? { ...T3_DEFAULT_THRESHOLDS };
          payload.masks = request.masksProvided ? request.masks : [];
          meta = store.create(payload);
        } else {
          payload.expectedRevision = request.expectedRevision;
          if (request.caseId !== null) payload.caseId = request.caseId;
          if (request.optionsPartial !== null) payload.options = request.optionsPartial;
          if (request.thresholdsPartial !== null) payload.thresholds = request.thresholdsPartial;
          if (request.masksProvided) payload.masks = request.masks;
          meta = store.update(payload);
        }
        if (meta && meta.meta) meta = meta.meta;
        if (!meta || typeof meta !== 'object') throw new BrowserError('VISION_BASELINE_WRITE_FAILED', '基线写入未返回元数据', { reason: 'io' });
        const evidence = t3BoundEvidence(t3Evidence({
          operation: 'baseline',
          provenance,
          source: [t3EvidenceSource(resolved, 'source')],
          baseline: [t3BaselineEvidenceEntry(meta)],
          metrics: {
            action: request.action,
            revision: meta.revision,
            caseId: meta.caseId ?? null,
            options: meta.options ?? null,
            thresholds: meta.thresholds ?? null,
            maskCount: Array.isArray(meta.masks) ? meta.masks.length : null,
            warnings,
          },
          verdict: { status: 'INCONCLUSIVE', reason: 'baseline-management' },
          output: { productId: resolved.product.productId, sha256: resolved.sha256, file: null, delivery: null },
          incomplete: [],
        }));
        runtime.noteVisionOperation('baseline', 'INCONCLUSIVE');
        return { ok: true, action: request.action, baseline: meta, product: resolved.product, provenance, evidence: { vision: evidence } };
      } catch (error) {
        const evidence = t3Evidence({
          operation: 'baseline',
          provenance,
          source: resolved ? [t3EvidenceSource(resolved, 'source')] : [],
          baseline: meta ? [t3BaselineEvidenceEntry(meta)] : [],
          verdict: { status: 'BLOCKED', reason: 'error' },
          metrics: { errorCode: error && error.code ? error.code : 'INTERNAL', action: request ? request.action : null, warnings },
          incomplete: ['operation-failed'],
        });
        runtime.noteVisionOperation('baseline', null);
        throw t3ThrowWithEvidence(error, evidence);
      } finally {
        t3ReleasePins(runtime, pins);
      }
    },
  });


  /* --- browser_vision_check ---------------------------------------------------------------- */
  const T3_STATUS_ORDER = Object.freeze(['FAIL', 'BLOCKED', 'INCONCLUSIVE', 'WARN', 'PASS']);
  function t3Verdict(statuses) {
    for (const status of T3_STATUS_ORDER) {
      if (statuses.includes(status)) return status;
    }
    return 'PASS';
  }
  function t3RectIntersects(a, b) {
    if (!a || !b) return false;
    const width = Math.min(a.x + a.width, b.x + b.width) - Math.max(a.x, b.x);
    const height = Math.min(a.y + a.height, b.y + b.height) - Math.max(a.y, b.y);
    return width > 0 && height > 0;
  }

  /** Fact schema (§7.1): no selector/HTML/free text; every nested object rejects unknown keys. */
  function t3Fact(value, name, ids) {
    const fact = t2Object(value, name);
    t2RejectUnknown(fact, [
      'id', 'provenance', 'rect', 'containerRect', 'visible', 'hitSamples', 'scroll', 'style',
      'textMetrics', 'presence', 'allowOverflow', 'allowTruncation',
    ], name);
    const id = t2StringField(fact.id, { name: `${name}.id`, maxBytes: 64 });
    if (!/^[a-zA-Z0-9][a-zA-Z0-9_-]{0,63}$/.test(id)) throw t3Invalid(`${name}.id 必须是合法 Name`, { path: `${name}.id` });
    if (ids.has(id)) throw t3Invalid(`${name}.id 重复`, { path: `${name}.id` });
    ids.add(id);
    const provenance = t2Object(fact.provenance, `${name}.provenance`);
    t2RejectUnknown(provenance, ['sourceTool', 'sourceActionId', 'observedAt', 'scopeId', 'runtimeId', 'pageGeneration', 'documentEpoch'], `${name}.provenance`);
    const sourceTool = t2StringField(provenance.sourceTool, { name: `${name}.provenance.sourceTool`, maxBytes: 64 });
    if (!T3_FACT_SOURCES.includes(sourceTool)) {
      throw t3Invalid(`${name}.provenance.sourceTool 只能是 ${T3_FACT_SOURCES.join('/')}`, { path: `${name}.provenance.sourceTool` });
    }
    const out = {
      id,
      provenance: {
        sourceTool,
        sourceActionId: t2StringField(provenance.sourceActionId, { name: `${name}.provenance.sourceActionId`, maxBytes: 128 }),
        observedAt: t2NumberField(provenance.observedAt, undefined, 0, Number.MAX_SAFE_INTEGER, `${name}.provenance.observedAt`),
        scopeId: t2StringField(provenance.scopeId, { name: `${name}.provenance.scopeId`, maxBytes: 128 }),
        runtimeId: t2StringField(provenance.runtimeId, { name: `${name}.provenance.runtimeId`, maxBytes: 128 }),
        pageGeneration: t2IntegerField(provenance.pageGeneration, undefined, 1, Number.MAX_SAFE_INTEGER, `${name}.provenance.pageGeneration`),
        documentEpoch: t2IntegerField(provenance.documentEpoch, undefined, 0, Number.MAX_SAFE_INTEGER, `${name}.provenance.documentEpoch`),
      },
    };
    if (fact.rect !== undefined) out.rect = vision.validateCssRect(fact.rect, `${name}.rect`);
    if (fact.containerRect !== undefined) out.containerRect = vision.validateCssRect(fact.containerRect, `${name}.containerRect`);
    if (fact.visible !== undefined) out.visible = t2BooleanField(fact.visible, undefined, `${name}.visible`);
    if (fact.hitSamples !== undefined) {
      if (!Array.isArray(fact.hitSamples) || fact.hitSamples.length < 1 || fact.hitSamples.length > 25) {
        throw t3Invalid(`${name}.hitSamples 必须是 1–25 项数组`, { path: `${name}.hitSamples` });
      }
      out.hitSamples = fact.hitSamples.map((sample, index) => {
        const item = t2Object(sample, `${name}.hitSamples[${index}]`);
        t2RejectUnknown(item, ['point', 'covered'], `${name}.hitSamples[${index}]`);
        return {
          point: vision.validatePoint(item.point, `${name}.hitSamples[${index}].point`),
          covered: t2BooleanField(item.covered, undefined, `${name}.hitSamples[${index}].covered`),
        };
      });
    }
    if (fact.scroll !== undefined) {
      const scroll = t2Object(fact.scroll, `${name}.scroll`);
      t2RejectUnknown(scroll, ['scrollWidth', 'scrollHeight', 'clientWidth', 'clientHeight'], `${name}.scroll`);
      out.scroll = {
        scrollWidth: t2NumberField(scroll.scrollWidth, undefined, 0, Number.MAX_SAFE_INTEGER, `${name}.scroll.scrollWidth`),
        scrollHeight: t2NumberField(scroll.scrollHeight, undefined, 0, Number.MAX_SAFE_INTEGER, `${name}.scroll.scrollHeight`),
        clientWidth: t2NumberField(scroll.clientWidth, undefined, 0, Number.MAX_SAFE_INTEGER, `${name}.scroll.clientWidth`),
        clientHeight: t2NumberField(scroll.clientHeight, undefined, 0, Number.MAX_SAFE_INTEGER, `${name}.scroll.clientHeight`),
      };
    }
    if (fact.style !== undefined) {
      const style = t2Object(fact.style, `${name}.style`);
      const allowed = ['overflowX', 'overflowY', 'whiteSpace', 'textOverflow', 'lineClamp', 'color', 'backgroundColor'];
      t2RejectUnknown(style, allowed, `${name}.style`);
      if (Object.keys(style).length === 0) throw t3Invalid(`${name}.style 不能是空对象`, { path: `${name}.style` });
      const outStyle = {};
      if (style.overflowX !== undefined) {
        if (!T3_OVERFLOW_VALUES.includes(style.overflowX)) throw t3Invalid(`${name}.style.overflowX 非法`, { path: `${name}.style.overflowX` });
        outStyle.overflowX = style.overflowX;
      }
      if (style.overflowY !== undefined) {
        if (!T3_OVERFLOW_VALUES.includes(style.overflowY)) throw t3Invalid(`${name}.style.overflowY 非法`, { path: `${name}.style.overflowY` });
        outStyle.overflowY = style.overflowY;
      }
      if (style.whiteSpace !== undefined) {
        if (!T3_WHITE_SPACE_VALUES.includes(style.whiteSpace)) throw t3Invalid(`${name}.style.whiteSpace 非法`, { path: `${name}.style.whiteSpace` });
        outStyle.whiteSpace = style.whiteSpace;
      }
      if (style.textOverflow !== undefined) {
        if (!T3_TEXT_OVERFLOW_VALUES.includes(style.textOverflow)) throw t3Invalid(`${name}.style.textOverflow 非法`, { path: `${name}.style.textOverflow` });
        outStyle.textOverflow = style.textOverflow;
      }
      if (style.lineClamp !== undefined) outStyle.lineClamp = t2IntegerField(style.lineClamp, undefined, 0, Number.MAX_SAFE_INTEGER, `${name}.style.lineClamp`);
      if (style.color !== undefined) outStyle.color = t3Rgb(style.color, `${name}.style.color`);
      if (style.backgroundColor !== undefined) outStyle.backgroundColor = t3Rgba(style.backgroundColor, `${name}.style.backgroundColor`);
      out.style = outStyle;
    }
    if (fact.textMetrics !== undefined) {
      const metrics = t2Object(fact.textMetrics, `${name}.textMetrics`);
      t2RejectUnknown(metrics, ['contentWidth', 'contentHeight', 'availableWidth', 'availableHeight'], `${name}.textMetrics`);
      out.textMetrics = {
        contentWidth: t2NumberField(metrics.contentWidth, undefined, 0, Number.MAX_SAFE_INTEGER, `${name}.textMetrics.contentWidth`),
        contentHeight: t2NumberField(metrics.contentHeight, undefined, 0, Number.MAX_SAFE_INTEGER, `${name}.textMetrics.contentHeight`),
        availableWidth: t2NumberField(metrics.availableWidth, undefined, 0, Number.MAX_SAFE_INTEGER, `${name}.textMetrics.availableWidth`),
        availableHeight: t2NumberField(metrics.availableHeight, undefined, 0, Number.MAX_SAFE_INTEGER, `${name}.textMetrics.availableHeight`),
      };
    }
    if (fact.presence !== undefined) {
      const presence = t2Object(fact.presence, `${name}.presence`);
      t2RejectUnknown(presence, ['expected', 'exists', 'searchComplete'], `${name}.presence`);
      out.presence = {
        expected: t2BooleanField(presence.expected, undefined, `${name}.presence.expected`),
        exists: t2BooleanField(presence.exists, undefined, `${name}.presence.exists`),
        searchComplete: t2BooleanField(presence.searchComplete, undefined, `${name}.presence.searchComplete`),
      };
    }
    if (fact.allowOverflow !== undefined) out.allowOverflow = t2BooleanField(fact.allowOverflow, false, `${name}.allowOverflow`);
    if (fact.allowTruncation !== undefined) out.allowTruncation = t2BooleanField(fact.allowTruncation, false, `${name}.allowTruncation`);
    return out;
  }

  /** `browser_vision_check` root arguments: the whole batch is validated before any case runs. */
  function t3CheckRequest(input) {
    t2RejectUnknown(input, ['cases'], 'browser_vision_check');
    if (!Array.isArray(input.cases)) throw t3Invalid('cases 必须是数组', { path: 'cases' });
    if (input.cases.length < 1 || input.cases.length > T3_MAX_CASES) {
      throw t3Invalid(`cases 必须是 1–${T3_MAX_CASES} 项`, { path: 'cases', count: input.cases.length });
    }
    const caseIds = new Set();
    return input.cases.map((raw, index) => {
      const name = `cases[${index}]`;
      const item = t2Object(raw, name);
      t2RejectUnknown(item, ['id', 'source', 'assertions', 'facts'], name);
      const id = t2StringField(item.id, { name: `${name}.id`, maxBytes: 64 });
      if (!/^[a-zA-Z0-9][a-zA-Z0-9_-]{0,63}$/.test(id)) throw t3Invalid(`${name}.id 必须是合法 Name`, { path: `${name}.id` });
      if (caseIds.has(id)) throw t3Invalid(`cases[].id 重复：${id}`, { path: `${name}.id` });
      caseIds.add(id);
      if (item.source === undefined || item.source === null) throw t3Invalid(`${name}.source 必填`, { path: `${name}.source` });
      if (!Array.isArray(item.assertions)) throw t3Invalid(`${name}.assertions 必须是数组`, { path: `${name}.assertions` });
      if (item.assertions.length < 1 || item.assertions.length > T3_MAX_ASSERTIONS) {
        throw t3Invalid(`${name}.assertions 必须是 1–${T3_MAX_ASSERTIONS} 项`, { path: `${name}.assertions`, count: item.assertions.length });
      }
      const assertionIds = new Set();
      const assertions = item.assertions.map((assertion, assertionIndex) => {
        const parsed = t3Assertion(assertion, `${name}.assertions[${assertionIndex}]`);
        if (assertionIds.has(parsed.id)) throw t3Invalid(`${name}.assertions[].id 重复：${parsed.id}`, { path: `${name}.assertions[${assertionIndex}].id` });
        assertionIds.add(parsed.id);
        return parsed;
      });
      const rawFacts = item.facts === undefined ? [] : item.facts;
      if (!Array.isArray(rawFacts)) throw t3Invalid(`${name}.facts 必须是数组`, { path: `${name}.facts` });
      if (rawFacts.length > T3_MAX_FACTS) throw t3Invalid(`${name}.facts 最多 ${T3_MAX_FACTS} 项`, { path: `${name}.facts`, count: rawFacts.length });
      const factIds = new Set();
      const facts = rawFacts.map((fact, factIndex) => t3Fact(fact, `${name}.facts[${factIndex}]`, factIds));
      return {
        id,
        source: vision.validateSource(item.source, `${name}.source`),
        assertions,
        facts,
      };
    });
  }
  function t3AssertionResult(assertion, status, reason, metrics, extra = {}) {
    return {
      id: assertion.id,
      type: assertion.type,
      severity: assertion.severity,
      status,
      reason,
      metrics: metrics || {},
      regions: Array.isArray(extra.regions) ? extra.regions : [],
      factIds: Array.isArray(extra.factIds) ? extra.factIds : [],
      diffProductId: extra.diffProductId ?? null,
      errorCode: extra.errorCode ?? null,
    };
  }
  function t3BlockedAssertion(assertion, error) {
    const code = error && error.code ? error.code : 'INTERNAL';
    return t3AssertionResult(assertion, 'BLOCKED', 'execution-error', {
      errorCode: code,
    }, { errorCode: code });
  }

  /** Fact fusion gate (§7.1): scope/runtime/page/document/time must all match the case image. */
  function t3FactFor(runtime, resolved, assertion, factsById) {
    if (!assertion.factId) return { fact: null, reason: null };
    const fact = factsById.get(assertion.factId);
    if (!fact) return { fact: null, reason: 'fact-not-provided' };
    const prov = fact.provenance;
    const scopeId = runtime.scope ? runtime.scope.id : null;
    if (prov.scopeId !== scopeId || prov.runtimeId !== runtime.runtimeId
      || prov.pageGeneration !== runtime.pageGeneration()
      || prov.documentEpoch !== runtime.documentEpoch()) {
      return { fact: null, reason: 'fact-stale-or-mismatch' };
    }
    const capturedAt = resolved.product ? resolved.product.capturedAt : null;
    if (!Number.isFinite(capturedAt) || !Number.isFinite(prov.observedAt) || Math.abs(prov.observedAt - capturedAt) > 1000) {
      return { fact: null, reason: 'fact-stale-or-mismatch' };
    }
    return { fact, reason: null };
  }

  /** ROI in document CSS (needed to intersect an external fact rect with the image region). */
  function t3RegionDocumentCss(resolved, region) {
    const mapping = resolved.product ? resolved.product.mapping : null;
    if (!mapping) return null;
    return vision.mapImageRectToDocument(mapping, region);
  }
  function t3RegionInsideRoi(region, image) {
    return region.x >= 0 && region.y >= 0
      && region.x + region.width <= image.width && region.y + region.height <= image.height;
  }

  /** Pixel-only layout/overflow signal: non-background components touching the ROI edges. */
  async function t3EdgeTouchSignal(image, roi, budget, signal) {
    const found = await vision.findInImageAsync(image, {
      method: 'components', background: [255, 255, 255], tolerance: 16, minArea: 1, maxResults: 100,
    }, { roi, ...t3AlgoOpts(budget, signal) }, t3AlgoOpts(budget, signal));
    const candidates = Array.isArray(found && found.candidates) ? found.candidates : [];
    let edgeTouchCount = 0;
    for (const candidate of candidates) {
      const box = candidate.region;
      if (!box) continue;
      if (box.x <= roi.x || box.y <= roi.y
        || box.x + box.width >= roi.x + roi.width || box.y + box.height >= roi.y + roi.height) {
        edgeTouchCount += 1;
      }
    }
    return { edgeTouchCount, components: candidates.length };
  }

  /** Pixel-only occlusion signal: 4×4 grid, dominant quantized bucket ≥0.95 covering ≥ half ROI. */
  function t3OcclusionSignal(image, roi) {
    let coveredPixels = 0;
    let maxDominantFraction = null;
    for (let gy = 0; gy < 4; gy += 1) {
      for (let gx = 0; gx < 4; gx += 1) {
        const x0 = roi.x + Math.floor(gx * roi.width / 4);
        const x1 = roi.x + Math.floor((gx + 1) * roi.width / 4);
        const y0 = roi.y + Math.floor(gy * roi.height / 4);
        const y1 = roi.y + Math.floor((gy + 1) * roi.height / 4);
        if (x1 <= x0 || y1 <= y0) continue;
        const buckets = new Map();
        let nonEmpty = 0;
        for (let y = y0; y < y1; y += 1) {
          for (let x = x0; x < x1; x += 1) {
            const offset = (y * image.width + x) * 4;
            if (image.rgba[offset + 3] === 0) continue;
            nonEmpty += 1;
            const key = ((image.rgba[offset] >> 4) << 8) | ((image.rgba[offset + 1] >> 4) << 4) | (image.rgba[offset + 2] >> 4);
            buckets.set(key, (buckets.get(key) || 0) + 1);
          }
        }
        if (nonEmpty === 0) continue;
        let dominant = 0;
        for (const count of buckets.values()) dominant = Math.max(dominant, count);
        const fraction = dominant / nonEmpty;
        maxDominantFraction = maxDominantFraction === null ? fraction : Math.max(maxDominantFraction, fraction);
        if (fraction >= 0.95) coveredPixels += (x1 - x0) * (y1 - y0);
      }
    }
    const roiPixels = roi.width * roi.height;
    return {
      signal: roiPixels > 0 && coveredPixels >= roiPixels / 2 && maxDominantFraction !== null && maxDominantFraction >= 0.95,
      dominantFraction: maxDominantFraction,
      coveredPixels,
      roiPixels,
    };
  }

  /** Pixel-only truncation signal: Sobel edge pixels inside the ROI right/bottom 1px band. */
  async function t3TruncationSignal(image, roi, budget, signal) {
    const edges = await vision.edgeMaskAsync(image, 32, t3AlgoOpts(budget, signal));
    let boundaryEdgePixels = 0;
    const xEdge = roi.x + roi.width - 1;
    const yEdge = roi.y + roi.height - 1;
    for (let y = roi.y; y < roi.y + roi.height; y += 1) {
      if (xEdge >= roi.x && edges[y * image.width + xEdge]) boundaryEdgePixels += 1;
    }
    for (let x = roi.x; x < roi.x + roi.width; x += 1) {
      if (yEdge >= roi.y && edges[yEdge * image.width + x]) boundaryEdgePixels += 1;
    }
    return { boundaryEdgePixels, signal: boundaryEdgePixels > 0 };
  }

  /** Pixel-only color signal: fraction of opaque ROI pixels matching the expected RGB. */
  function t3ColorSignal(image, roi, expectedColor, tolerance, minFraction) {
    let sampledPixels = 0;
    let matchingPixels = 0;
    for (let y = roi.y; y < roi.y + roi.height; y += 1) {
      for (let x = roi.x; x < roi.x + roi.width; x += 1) {
        const offset = (y * image.width + x) * 4;
        if (image.rgba[offset + 3] === 0) continue;
        sampledPixels += 1;
        const delta = Math.max(
          Math.abs(image.rgba[offset] - expectedColor[0]),
          Math.abs(image.rgba[offset + 1] - expectedColor[1]),
          Math.abs(image.rgba[offset + 2] - expectedColor[2]),
        );
        if (delta <= tolerance) matchingPixels += 1;
      }
    }
    const matchingFraction = sampledPixels === 0 ? 0 : matchingPixels / sampledPixels;
    return {
      sampledPixels,
      matchingPixels,
      matchingFraction,
      signal: sampledPixels === 0 ? null : matchingFraction < minFraction,
    };
  }

  /** Pixel-only missing signal: explicit query candidate count inside the ROI. */
  async function t3MissingSignal(runtime, exec, image, roi, assertion, pins, budget, warnings) {
    const templateResolved = await t3TemplateImage(runtime, exec, assertion.query, pins, budget);
    const found = await vision.findInImageAsync(image, assertion.query, {
      roi, templateImage: templateResolved ? templateResolved.image : null,
      ...t3AlgoOpts(budget, exec.signal),
    }, t3AlgoOpts(budget, exec.signal));
    const candidates = Array.isArray(found && found.candidates) ? found.candidates : [];
    return {
      candidateCount: Number.isInteger(found && found.totalCandidates) ? found.totalCandidates : candidates.length,
      candidates,
      signal: candidates.length < assertion.minCount,
    };
  }
  function t3RgbDelta(a, b) {
    return Math.max(Math.abs(a[0] - b[0]), Math.abs(a[1] - b[1]), Math.abs(a[2] - b[2]));
  }
  function t3StyleBackground(fact) {
    const background = fact && fact.style ? fact.style.backgroundColor : null;
    if (!background) return null;
    if (Array.isArray(background)) {
      if (background.length !== 4) return null;
      return { rgba: background, alpha: background[3] };
    }
    if (typeof background === 'object' && background && background.a !== undefined) {
      return { rgba: [background.r, background.g, background.b, background.a], alpha: background.a };
    }
    return null;
  }

  /**
   * One defect assertion (§7.2): pixel signal + optional external fact, with the required/advisory
   * matrix. `metrics` only carries the bounded numeric/boolean fields named by the contract.
   */
  async function t3DefectAssertion(runtime, exec, testCase, assertion, resolved, factsById, pins, budget, warnings) {
    const image = resolved.image;
    const region = assertion.region;
    if (!t3RegionInsideRoi(region, image)) {
      throw t3Invalid(`${assertion.type} region 超出图像边界`, { path: `assertions[${assertion.id}].region` });
    }
    const severity = assertion.severity;
    const required = severity === 'required';
    const factMatch = t3FactFor(runtime, resolved, assertion, factsById);
    const fact = factMatch.fact;
    const factIds = fact ? [fact.id] : [];
    const metricsBase = { pixelSignal: null, factsVerified: false, fusion: 'none', warnings };
    // Every defect assertion cites its ROI as evidence (image px + document CSS when mapped).
    const roiRegion = t3EvidenceRegion({
      id: assertion.id,
      role: 'roi',
      imagePixels: region,
      beforeDocumentCss: null,
      afterDocumentCss: t3RegionDocumentCss(resolved, region),
      area: region.width * region.height,
    });
    const degraded = (reason, extra = {}) => t3AssertionResult(assertion, 'INCONCLUSIVE', reason, {
      ...metricsBase, ...extra,
    }, { factIds, regions: [roiRegion] });
    // Required defect rules need a live/capture lineage source with a usable mapping (§7.1).
    if (required) {
      if (!resolved.product || resolved.product.capturedAt === null || resolved.product.mapping === null) {
        return degraded('source-not-live');
      }
    }
    if (assertion.factId && factMatch.reason) {
      const pixelSignal = await t3PixelSignal(runtime, exec, assertion, image, region, pins, budget, warnings);
      return t3AssertionResult(assertion, required ? 'INCONCLUSIVE' : (pixelSignal.signal === true ? 'WARN' : 'INCONCLUSIVE'),
        factMatch.reason, { ...metricsBase, ...pixelSignal.metrics, pixelSignal: pixelSignal.signal, fusion: 'pixels-only' },
        { factIds: [] });
    }
    const pixelSignal = await t3PixelSignal(runtime, exec, assertion, image, region, pins, budget, warnings);
    const pixelMetrics = { ...pixelSignal.metrics, pixelSignal: pixelSignal.signal };
    if (assertion.type === 'layout') {
      if (!fact || !fact.rect || !assertion.expectedRect) {
        if (!required) return t3AssertionResult(assertion, pixelSignal.signal === true ? 'WARN' : 'INCONCLUSIVE', 'insufficient-facts', { ...metricsBase, ...pixelMetrics, fusion: 'pixels-only' }, { factIds, regions: [roiRegion] });
        return degraded('insufficient-facts', pixelMetrics);
      }
      const regionCss = t3RegionDocumentCss(resolved, region);
      if (!regionCss || !t3RectIntersects(fact.rect, regionCss)) return degraded('fact-region-mismatch', pixelMetrics);
      const maxDeltaCss = Math.max(
        Math.abs(fact.rect.x - assertion.expectedRect.x),
        Math.abs(fact.rect.y - assertion.expectedRect.y),
        Math.abs(fact.rect.width - assertion.expectedRect.width),
        Math.abs(fact.rect.height - assertion.expectedRect.height),
      );
      const failed = maxDeltaCss > assertion.toleranceCss;
      return t3AssertionResult(assertion, failed ? (required ? 'FAIL' : 'WARN') : 'PASS', 'layout-delta', {
        ...metricsBase, ...pixelMetrics, fusion: 'external-facts',
        maxDeltaCss, toleranceCss: assertion.toleranceCss, edgeTouchCount: pixelSignal.metrics.edgeTouchCount ?? null,
      }, { factIds, regions: [roiRegion] });
    }
    if (assertion.type === 'occlusion') {
      if (!fact || !fact.rect || fact.visible === undefined) {
        if (!required) return t3AssertionResult(assertion, pixelSignal.signal === true ? 'WARN' : 'INCONCLUSIVE', 'insufficient-facts', { ...metricsBase, ...pixelMetrics, fusion: 'pixels-only' }, { factIds, regions: [roiRegion] });
        return degraded('insufficient-facts', pixelMetrics);
      }
      if (fact.visible === false) return degraded('invisible', pixelMetrics);
      const samples = Array.isArray(fact.hitSamples) ? fact.hitSamples : [];
      const center = { x: fact.rect.x + fact.rect.width / 2, y: fact.rect.y + fact.rect.height / 2 };
      const unique = new Map();
      let hasCenter = false;
      const quadrants = new Set();
      for (const sample of samples) {
        const key = sample.point.x + ':' + sample.point.y;
        if (unique.has(key)) continue;
        unique.set(key, sample);
        if (sample.point.x < fact.rect.x || sample.point.y < fact.rect.y
          || sample.point.x > fact.rect.x + fact.rect.width || sample.point.y > fact.rect.y + fact.rect.height) continue;
        if (sample.point.x === center.x && sample.point.y === center.y) hasCenter = true;
        quadrants.add((sample.point.x < center.x ? 'l' : 'r') + (sample.point.y < center.y ? 't' : 'b'));
      }
      if (unique.size < 5 || !hasCenter || quadrants.size < 4) {
        if (!required) return t3AssertionResult(assertion, pixelSignal.signal === true ? 'WARN' : 'INCONCLUSIVE', 'insufficient-samples', { ...metricsBase, ...pixelMetrics, fusion: 'pixels-only' }, { factIds, regions: [roiRegion] });
        return degraded('insufficient-samples', pixelMetrics);
      }
      let coveredSamples = 0;
      for (const sample of unique.values()) if (sample.covered === true) coveredSamples += 1;
      const coveredRatio = coveredSamples / unique.size;
      const failed = coveredRatio > assertion.maxCoveredRatio;
      return t3AssertionResult(assertion, failed ? (required ? 'FAIL' : 'WARN') : 'PASS', 'occlusion-ratio', {
        ...metricsBase, ...pixelMetrics, fusion: 'external-facts',
        samples: unique.size, coveredSamples, coveredRatio,
        maxCoveredRatio: assertion.maxCoveredRatio,
        dominantFraction: pixelSignal.metrics.dominantFraction ?? null,
      }, { factIds, regions: [roiRegion] });
    }
    if (assertion.type === 'overflow') {
      if (!fact || !fact.scroll || !fact.style || !fact.style.overflowX || !fact.style.overflowY) {
        if (!required) return t3AssertionResult(assertion, pixelSignal.signal === true ? 'WARN' : 'INCONCLUSIVE', 'insufficient-facts', { ...metricsBase, ...pixelMetrics, fusion: 'pixels-only' }, { factIds, regions: [roiRegion] });
        return degraded('insufficient-facts', pixelMetrics);
      }
      const regionCss = t3RegionDocumentCss(resolved, region);
      if (!regionCss || !t3RectIntersects(fact.rect ?? regionCss, regionCss)) return degraded('fact-region-mismatch', pixelMetrics);
      const overflowXCss = Math.max(0, fact.scroll.scrollWidth - fact.scroll.clientWidth);
      const overflowYCss = Math.max(0, fact.scroll.scrollHeight - fact.scroll.clientHeight);
      const allowOverflow = fact.allowOverflow === true;
      const failX = overflowXCss > assertion.toleranceCss && fact.style.overflowX === 'visible' && !allowOverflow;
      const failY = overflowYCss > assertion.toleranceCss && fact.style.overflowY === 'visible' && !allowOverflow;
      const failed = failX || failY;
      return t3AssertionResult(assertion, failed ? (required ? 'FAIL' : 'WARN') : 'PASS', 'overflow-scroll', {
        ...metricsBase, ...pixelMetrics, fusion: 'external-facts',
        overflowXCss, overflowYCss, toleranceCss: assertion.toleranceCss, allowed: allowOverflow,
        edgeTouchCount: pixelSignal.metrics.edgeTouchCount ?? null,
      }, { factIds, regions: [roiRegion] });
    }
    if (assertion.type === 'truncation') {
      if (!fact || !fact.textMetrics || !fact.style) {
        if (!required) return t3AssertionResult(assertion, pixelSignal.signal === true ? 'WARN' : 'INCONCLUSIVE', 'insufficient-facts', { ...metricsBase, ...pixelMetrics, fusion: 'pixels-only' }, { factIds, regions: [roiRegion] });
        return degraded('insufficient-facts', pixelMetrics);
      }
      const regionCss = t3RegionDocumentCss(resolved, region);
      if (!regionCss || !t3RectIntersects(fact.rect ?? regionCss, regionCss)) return degraded('fact-region-mismatch', pixelMetrics);
      const excessWidthCss = Math.max(0, fact.textMetrics.contentWidth - fact.textMetrics.availableWidth);
      const excessHeightCss = Math.max(0, fact.textMetrics.contentHeight - fact.textMetrics.availableHeight);
      const clipX = ['hidden', 'clip'].includes(fact.style.overflowX);
      const clipY = ['hidden', 'clip'].includes(fact.style.overflowY);
      const lineClamp = Number.isInteger(fact.style.lineClamp) ? fact.style.lineClamp : 0;
      const clipped = (excessWidthCss > assertion.toleranceCss && clipX)
        || (excessHeightCss > assertion.toleranceCss && clipY)
        || (lineClamp > 0 && excessHeightCss > assertion.toleranceCss);
      const allowTruncation = fact.allowTruncation === true;
      return t3AssertionResult(assertion, clipped && !allowTruncation ? (required ? 'FAIL' : 'WARN') : 'PASS', 'truncation-clip', {
        ...metricsBase, ...pixelMetrics, fusion: 'external-facts',
        excessWidthCss, excessHeightCss, clipped, allowed: allowTruncation,
        toleranceCss: assertion.toleranceCss,
        boundaryEdgePixels: pixelSignal.metrics.boundaryEdgePixels ?? null,
      }, { factIds, regions: [roiRegion] });
    }
    if (assertion.type === 'color') {
      const background = t3StyleBackground(fact);
      const pixelMatch = pixelSignal.signal !== null && pixelSignal.signal === false;
      if (!fact || !fact.rect || !background) {
        if (!required) return t3AssertionResult(assertion, pixelSignal.signal === true ? 'WARN' : 'INCONCLUSIVE', 'insufficient-facts', { ...metricsBase, ...pixelMetrics, fusion: 'pixels-only' }, { factIds, regions: [roiRegion] });
        return degraded('insufficient-facts', pixelMetrics);
      }
      const regionCss = t3RegionDocumentCss(resolved, region);
      if (!regionCss) return degraded('mapping-unavailable', pixelMetrics);
      const inside = regionCss.x >= fact.rect.x && regionCss.y >= fact.rect.y
        && regionCss.x + regionCss.width <= fact.rect.x + fact.rect.width
        && regionCss.y + regionCss.height <= fact.rect.y + fact.rect.height;
      if (!inside) return degraded('fact-region-mismatch', pixelMetrics);
      if (background.alpha !== 255) return degraded('transparent-background', pixelMetrics);
      const styleMatches = t3RgbDelta(background.rgba, assertion.expectedColor) <= assertion.tolerance;
      let status;
      let reason;
      if (pixelMatch && styleMatches) { status = 'PASS'; reason = 'color-consistent'; }
      else if (!pixelMatch && !styleMatches) { status = required ? 'FAIL' : 'WARN'; reason = 'color-mismatch'; }
      else { status = 'INCONCLUSIVE'; reason = 'conflicting-signals'; }
      return t3AssertionResult(assertion, status, reason, {
        ...metricsBase, ...pixelMetrics, fusion: 'external-facts',
        sampledPixels: pixelSignal.metrics.sampledPixels,
        matchingPixels: pixelSignal.metrics.matchingPixels,
        matchingFraction: pixelSignal.metrics.matchingFraction,
        minFraction: assertion.minFraction,
        tolerance: assertion.tolerance,
        styleMatches,
      }, { factIds, regions: [roiRegion] });
    }
    // missing
    const presence = fact ? fact.presence : null;
    if (!presence || presence.expected !== true || presence.searchComplete !== true) {
      if (!required) return t3AssertionResult(assertion, pixelSignal.signal === true ? 'WARN' : 'INCONCLUSIVE', 'insufficient-facts', { ...metricsBase, ...pixelMetrics, fusion: 'pixels-only' }, { factIds, regions: [roiRegion] });
      return degraded('insufficient-facts', pixelMetrics);
    }
    const candidateCount = pixelSignal.metrics.candidateCount ?? 0;
    const failed = candidateCount < assertion.minCount && presence.exists === false;
    const passed = candidateCount >= assertion.minCount && presence.exists === true;
    let status;
    let reason;
    if (failed) { status = required ? 'FAIL' : 'WARN'; reason = 'component-missing'; }
    else if (passed) { status = 'PASS'; reason = 'component-present'; }
    else { status = 'INCONCLUSIVE'; reason = 'conflicting-presence'; }
    return t3AssertionResult(assertion, status, reason, {
      ...metricsBase, ...pixelMetrics, fusion: 'external-facts',
      candidateCount, minCount: assertion.minCount,
      expected: presence.expected, exists: presence.exists, searchComplete: presence.searchComplete,
    }, { factIds, regions: [roiRegion] });
  }

  /** Pixel signal for one defect type (advisory-only evidence; never a required conclusion). */
  async function t3PixelSignal(runtime, exec, assertion, image, region, pins, budget, warnings) {
    if (assertion.type === 'layout' || assertion.type === 'overflow') {
      const signal = await t3EdgeTouchSignal(image, region, budget, exec.signal);
      return { signal: signal.edgeTouchCount > 0, metrics: { edgeTouchCount: signal.edgeTouchCount, components: signal.components } };
    }
    if (assertion.type === 'occlusion') {
      const signal = t3OcclusionSignal(image, region);
      return {
        signal: signal.signal,
        metrics: {
          dominantFraction: signal.dominantFraction,
          coveredPixels: signal.coveredPixels,
          roiPixels: signal.roiPixels,
        },
      };
    }
    if (assertion.type === 'truncation') {
      const signal = await t3TruncationSignal(image, region, budget, exec.signal);
      return { signal: signal.signal, metrics: { boundaryEdgePixels: signal.boundaryEdgePixels } };
    }
    if (assertion.type === 'color') {
      const signal = t3ColorSignal(image, region, assertion.expectedColor, assertion.tolerance, assertion.minFraction);
      return {
        signal: signal.signal,
        metrics: {
          sampledPixels: signal.sampledPixels,
          matchingPixels: signal.matchingPixels,
          matchingFraction: signal.matchingFraction,
        },
      };
    }
    const signal = await t3MissingSignal(runtime, exec, image, region, assertion, pins, budget, warnings);
    return { signal: signal.signal, metrics: { candidateCount: signal.candidateCount } };
  }

  /** Regression assertion (§2.7/§8.3): baseline is the before image, case source is after. */
  async function t3RegressionAssertion(runtime, exec, assertion, resolved, pins, budget, warnings) {
    const store = t3BaselineStore(runtime, exec);
    let got;
    try {
      got = assertion.revision === undefined ? store.get(assertion.baseline) : store.get(assertion.baseline, assertion.revision);
    } catch (error) {
      if (error instanceof BrowserError && error.code === 'VISION_BASELINE_NOT_FOUND') {
        return t3AssertionResult(assertion, 'BLOCKED', 'baseline-not-found', { warnings }, { errorCode: 'VISION_BASELINE_NOT_FOUND' });
      }
      throw error;
    }
    const baseline = t3BaselineGetResult(got);
    if (!baseline.meta || !baseline.pngBytes) {
      return t3AssertionResult(assertion, 'BLOCKED', 'baseline-not-found', { warnings }, { errorCode: 'VISION_BASELINE_NOT_FOUND' });
    }
    const beforeBytes = Buffer.isBuffer(baseline.pngBytes) ? baseline.pngBytes : Buffer.from(baseline.pngBytes);
    const beforeDecoded = await t3Decode(beforeBytes, exec.signal, budget);
    const afterImage = resolved.image;
    if (beforeDecoded.width !== afterImage.width || beforeDecoded.height !== afterImage.height) {
      return t3AssertionResult(assertion, 'BLOCKED', 'size-mismatch', {
        before: { width: beforeDecoded.width, height: beforeDecoded.height },
        after: { width: afterImage.width, height: afterImage.height },
        warnings,
      }, { errorCode: 'VISION_SIZE_MISMATCH' });
    }
    const beforeImage = { width: beforeDecoded.width, height: beforeDecoded.height, rgba: beforeDecoded.rgba };
    const beforeMapping = baseline.meta.mapping ?? null;
    const afterMapping = resolved.product ? resolved.product.mapping : null;
    const mappingCompatible = Boolean(beforeMapping && afterMapping && vision.mappingCompatible(beforeMapping, afterMapping));
    if (assertion.severity === 'required' && !mappingCompatible) {
      // §8.3: a missing mapping is "mapping-unavailable"; two incompatible mappings is
      // "mapping-incompatible". Either way no required PASS is claimed and no file is published.
      const reason = !beforeMapping || !afterMapping ? 'mapping-unavailable' : 'mapping-incompatible';
      return t3AssertionResult(assertion, 'BLOCKED', reason, {
        mappingCompatible: false, warnings,
      }, { errorCode: null });
    }
    if (!mappingCompatible) t3Warning(warnings, 'mapping-incompatible');
    const region = assertion.region ?? { x: 0, y: 0, width: afterImage.width, height: afterImage.height };
    if (!t3RegionInsideRoi(region, afterImage)) {
      throw t3Invalid(`regression region 超出图像边界`, { path: `assertions[${assertion.id}].region` });
    }
    let masks = assertion.masks !== undefined ? assertion.masks
      : Array.isArray(baseline.meta.masks) ? baseline.meta.masks : [];
    t3ValidateMaskBounds(masks, afterImage);
    let options = { ...T3_DEFAULT_DIFF_OPTIONS };
    if (baseline.meta.options) options = { ...options, ...baseline.meta.options };
    options = t3MergeResolved(options, assertion.options ?? null, vision.validateDiffOptions, 'options');
    let thresholds = { ...T3_DEFAULT_THRESHOLDS };
    if (baseline.meta.thresholds) thresholds = { ...thresholds, ...baseline.meta.thresholds };
    thresholds = t3MergeResolved(thresholds, assertion.thresholds ?? null, vision.validateThresholds, 'thresholds');
    if (!(thresholds.warnRatio <= thresholds.failRatio)) throw t3Invalid('thresholds 必须满足 0 ≤ warnRatio ≤ failRatio ≤ 1', { path: 'thresholds' });
    const diff = await vision.diffImagesAsync(beforeImage, afterImage, {
      region, masks, options, ...t3AlgoOpts(budget, exec.signal),
    }, t3AlgoOpts(budget, exec.signal));
    if (!diff || !diff.metrics || diff.metrics.comparedPixels === 0) {
      return t3AssertionResult(assertion, 'BLOCKED', 'empty-comparison', { warnings }, { errorCode: 'VISION_EMPTY_COMPARISON' });
    }
    const ratioVerdict = t3RatioVerdict(diff.metrics.diffRatio, thresholds);
    let status = ratioVerdict;
    if (ratioVerdict === 'FAIL' && assertion.severity === 'advisory') status = 'WARN';
    const highlight = Buffer.isBuffer(diff.highlight) ? diff.highlight : Buffer.from(diff.highlight ?? []);
    const diffProduct = t3ProductPublic(t3AddProduct(runtime, {
      bytes: highlight, width: beforeImage.width, height: beforeImage.height, sha256: t3Sha256(highlight),
      rgbaSha256: null, kind: 'diff', mapping: null, actionable: false,
      parentIds: [], operations: [{ op: 'diff', parameters: { resolvedOptions: options, resolvedThresholds: thresholds, resolvedMasks: masks } }],
      capturedAt: null, provenance: t3Provenance(runtime, exec),
    }));
    const metrics = {
      ...diff.metrics,
      resolvedOptions: options,
      resolvedThresholds: thresholds,
      resolvedMasks: masks,
      beforeSha256: t3Sha256(beforeBytes),
      afterSha256: resolved.sha256,
      baselineRevision: baseline.meta.revision,
      headToken: baseline.meta.headToken ?? null,
      mappingCompatible,
      warnings,
    };
    return t3AssertionResult(assertion, status, 'ratio', metrics, {
      diffProductId: diffProduct.productId,
      regions: (Array.isArray(diff.regions) ? diff.regions : []).slice(0, T3_EVIDENCE_REGIONS).map((item) => t3EvidenceRegion({
        id: item.id,
        role: 'diff',
        imagePixels: item.imagePixels ?? item.region ?? null,
        beforeDocumentCss: mappingCompatible && beforeMapping && (item.imagePixels || item.region)
          ? vision.mapImageRectToDocument(beforeMapping, item.imagePixels ?? item.region) : null,
        afterDocumentCss: mappingCompatible && afterMapping && (item.imagePixels || item.region)
          ? vision.mapImageRectToDocument(afterMapping, item.imagePixels ?? item.region) : null,
        area: item.area,
      })),
    });
  }
  async function t3RunAssertion(runtime, exec, testCase, assertion, resolved, factsById, pins, budget, warnings) {
    if (assertion.type === 'regression') {
      return t3RegressionAssertion(runtime, exec, assertion, resolved, pins, budget, warnings);
    }
    return t3DefectAssertion(runtime, exec, testCase, assertion, resolved, factsById, pins, budget, warnings);
  }

  /** Run one case: resolve the source once, run every assertion, release the case pins. */
  async function t3RunCase(runtime, exec, testCase, budget, warnings, liveScale = null) {
    const pins = [];
    const assertionResults = [];
    const incomplete = [];
    let resolved = null;
    const factsById = new Map(testCase.facts.map((fact) => [fact.id, fact]));
    try {
      resolved = await t3ResolveSource(runtime, exec, testCase.source, 'source', pins, budget, liveScale);
      for (const assertion of testCase.assertions) {
        try {
          assertionResults.push(await t3RunAssertion(runtime, exec, testCase, assertion, resolved, factsById, pins, budget, warnings));
        } catch (error) {
          if (error && ['ABORTED', 'CDP_TIMEOUT', 'CDP_DISCONNECTED'].includes(error.code)) throw error;
          assertionResults.push(t3BlockedAssertion(assertion, error));
        }
      }
    } catch (error) {
      if (error && ['ABORTED', 'CDP_TIMEOUT', 'CDP_DISCONNECTED'].includes(error.code)) throw error;
      for (const assertion of testCase.assertions) assertionResults.push(t3BlockedAssertion(assertion, error));
      incomplete.push('source-unavailable');
    } finally {
      t3ReleasePins(runtime, pins);
    }
    return {
      result: {
        id: testCase.id,
        sourceProductId: resolved && resolved.product ? resolved.product.productId : null,
        assertions: assertionResults,
        verdict: t3Verdict(assertionResults.map((item) => item.status)),
        incomplete,
      },
      source: resolved ? t3EvidenceSource(resolved, 'source') : null,
    };
  }

  register({
    name: 'browser_vision_check',
    description: 'T3 静态视觉回归/缺陷用例集：cases 1–20，每 case 1–32 assertions、0–64 facts，整批先做纯参数校验再逐 case 执行。'
      + 'assertion.type=regression（与基线比较，不发布文件）或 layout/occlusion/overflow/truncation/color/missing（像素信号 + 调用方显式提供的外部事实融合）。'
      + 'required 缺必需事实/来源不匹配返回 INCONCLUSIVE/BLOCKED，advisory 最多 WARN；regression 需兼容 mapping，baseline 缺失为 BLOCKED。'
      + '返回 summary/verdict/exitCode（FAIL→1，无 FAIL 但 BLOCKED/INCONCLUSIVE→2，PASS/WARN→0），不调用 process.exit。'
      + '不导航、不建/更新基线、不读 DOM（facts 由调用方提供并标记 trusted=false）。',
    parameters: {
      type: 'object',
      additionalProperties: false,
      required: ['cases'],
      properties: {
        cases: {
          type: 'array',
          description: 'Case[]（1–20）：{id, source, assertions[1–32], facts?[0–64]}。',
          items: { type: 'object' },
        },
      },
    },
    output: { schema: { type: 'object' }, render: (args, value) => text(value) },
    async execute(args, exec) {
      const runtime = exec.runtime;
      const provenance = t3Provenance(runtime, exec);
      const budget = t3NewBudget();
      const warnings = [];
      const caseResults = [];
      const evidenceSources = [];
      const evidenceFacts = [];
      let request = null;
      try {
        request = t3CheckRequest(args && typeof args === 'object' ? args : {});
        // One frozen default scale for every case of this call.
        const liveScale = runtime.view.scale;
        for (const testCase of request) {
          const { result, source } = await t3RunCase(runtime, exec, testCase, budget, warnings, liveScale);
          caseResults.push(result);
          if (source && !evidenceSources.some((entry) => entry.productId === source.productId)) {
            evidenceSources.push(source);
          }
          for (const fact of testCase.facts) {
            evidenceFacts.push({
              id: fact.id,
              sourceActionId: fact.provenance.sourceActionId,
              observedAt: fact.provenance.observedAt,
              documentEpoch: fact.provenance.documentEpoch,
              trusted: false,
            });
          }
        }
        const summary = { pass: 0, warn: 0, fail: 0, inconclusive: 0, blocked: 0 };
        for (const result of caseResults) {
          for (const assertion of result.assertions) {
            if (assertion.status === 'PASS') summary.pass += 1;
            else if (assertion.status === 'WARN') summary.warn += 1;
            else if (assertion.status === 'FAIL') summary.fail += 1;
            else if (assertion.status === 'BLOCKED') summary.blocked += 1;
            else summary.inconclusive += 1;
          }
        }
        let verdict = t3Verdict(caseResults.map((result) => result.verdict));
        let exitCode = verdict === 'FAIL' ? 1 : (verdict === 'BLOCKED' || verdict === 'INCONCLUSIVE') ? 2 : 0;
        const evidenceRegions = [];
        for (const result of caseResults) {
          for (const assertion of result.assertions) {
            for (const region of assertion.regions) evidenceRegions.push(region);
          }
        }
        const evidence = t3Evidence({
          operation: 'check',
          provenance,
          source: evidenceSources,
          regions: evidenceRegions.slice(0, T3_EVIDENCE_REGIONS),
          metrics: { summary, caseCount: caseResults.length, assertionCount: summary.pass + summary.warn + summary.fail + summary.inconclusive + summary.blocked, warnings },
          facts: evidenceFacts,
          verdict: { status: verdict, reason: 'summary' },
          incomplete: caseResults.some((result) => result.incomplete.length > 0) ? ['case-incomplete'] : [],
        });
        t3BoundEvidence(evidence);
        if (evidence.truncated && verdict === 'PASS') {
          // Truncated evidence cannot support an unqualified PASS (contract §3.2).
          verdict = 'INCONCLUSIVE';
          exitCode = 2;
          evidence.verdict = { status: verdict, reason: 'evidence-truncated' };
          evidence.incomplete = [...evidence.incomplete, 'evidence-truncated'];
        }
        runtime.noteVisionOperation('check', verdict);
        return {
          ok: true,
          cases: caseResults,
          summary,
          verdict,
          exitCode,
          evidence: { vision: evidence },
        };
      } catch (error) {
        const evidence = t3Evidence({
          operation: 'check',
          provenance,
          source: evidenceSources,
          verdict: { status: 'BLOCKED', reason: 'error' },
          metrics: {
            errorCode: error && error.code ? error.code : 'INTERNAL',
            completedCases: caseResults.length,
            warnings,
          },
          facts: evidenceFacts,
          incomplete: ['operation-failed'],
        });
        runtime.noteVisionOperation('check', null);
        const thrown = t3ThrowWithEvidence(error, evidence);
        // ABORTED / CDP disconnect / queue timeout: the already-finished cases travel with the
        // original error (they are not re-judged and no further evidence is collected).
        thrown.details = {
          ...thrown.details,
          completedCases: caseResults.map((result) => ({
            id: result.id,
            verdict: result.verdict,
            assertions: result.assertions.map((assertion) => ({
              id: assertion.id, type: assertion.type, severity: assertion.severity,
              status: assertion.status, reason: assertion.reason, errorCode: assertion.errorCode,
            })),
          })),
        };
        throw thrown;
      }
    },
  });

  register({
    name: 'browser_capabilities',
    description: '查询 Web T1/T2/T3/P0 工具、运行态、隔离模式及证据限制；不会启动浏览器（不 ensure、不建目录、不生成 product、不申请租约）。'
      + 'viewport 段报告共享视口 get/set 边界、预设、比例范围与 limits.viewport（observed 只来自真实读回）；'
      + 'vision 段报告 T3 算法版本/工具/源类型/预算与最近一次真实视觉调用（observed），六个 web.t3.* 与聚合 web.t3.static-vision 按 BUSY 状态报告；'
      + 'network 段报告 7 个 browser_network_* 工具、会话计数器/完整性与 limits.network（含 responseModification 是否受 CDP 支持）；'
      + 'dynamic 段报告 T4 动态行为（M1 起）：实际注册的 browser_dynamic_session/browser_motion_* 工具、帧源/编码/算法/适配器、DC 枚举与 limits.dynamic，observed 只来自真实 T4 调用、未启动不算 unsupported；'
      + 'dynamic.assertions 给出机器可读的七类断言规格（allowed/required/枚举/默认阈值），dynamic.sampling 说明 requested 与 measured 语义，顶层 limitations 声明“实际 fps 以 measured 为准、低采样不得证明无异常”。',
    parameters: { type: 'object', properties: {}, required: [] },
    output: { schema: { type: 'object' }, render: (args, value) => text(value) },
    async execute(args, exec) {
      const runtime = exec.runtime;
      const running = Boolean(runtime.cdp && !runtime.cdp.closed);
      const owner = runtime.state().owner.sessionId;
      const busy = owner && owner !== exec.meta.sessionId;
      const pageTools = ['navigate', 'eval', 'screenshot', 'input', 'network', 'computed_style'];
      // T2 surface: snapshot + the six structured actions. All of them are page operations (lazy
      // start, serial queue, single-owner lease) and all of them return structured evidence.
      const t2Tools = ['snapshot', 'click', 'type', 'scroll', 'fill_form', 'node_state', 'wait_for'];
      // T3 surface: six static-vision tools. All of them enter the scope queue and the owner check
      // (offline baseline list/get/delete included); only a live source or `act` starts a page.
      const t3Tools = ['vision_image', 'vision_find', 'vision_compare', 'vision_act', 'vision_baseline', 'vision_check'];
      const t3CapabilityIds = ['web.t3.image', 'web.t3.find', 'web.t3.compare', 'web.t3.act', 'web.t3.baseline', 'web.t3.check'];
      const diagnosticTools = ['state', 'capabilities'];
      // Web P0 network surface (docs/network-p0.md). Read-only actions stay available even when
      // another session owns the page; `session` mutations and page-bound `control` actions report
      // unavailable(BUSY) like every other page operation.
      const networkTools = ['session', 'events', 'detail', 'trace', 'control', 'evidence', 'subscribe'];
      const networkConstraints = [
        'declared, never probed: reading this starts no Chromium and takes no lease',
        'session.start is the only lazy-start action; status/reset, events, detail, trace reads, evidence and subscribe never start a page',
        'collector is per workspace scope (events/bodies/steps/links/artifacts/subscriptions)',
        'G1.5 iframe/OOPIF/worker coverage is partial: popups stay blocked and shared/service workers are refused when attribution cannot be proven',
        'not a MITM proxy: no CA install, no TLS key reading, no cookie export',
      ];
      const pageConstraints = ['page tools lazily start Chromium; startup may fail', 'single owner lease; shared page with panel'];
      const t2Constraints = [
        'structured DOM/AX tier: refs come from browser_snapshot; numbers are monotonic, never reused, LRU-capped at ' + T2_LIMITS.maxRefs,
        'A newer snapshot does NOT invalidate older refs; a document commit, main-context loss or close clears them (REF_STALE)',
        'Trusted CDP input for click/type/form booleans; native select/range writes report eventSource=dom-control',
        'Every action returns version=1 structured evidence; no force/JS-click escape hatch and no pixel/visual judgement (T3)',
      ];
      const t3Constraints = [
        'static vision only: PNG processing, deterministic recognition, pixel diff and coordinate input; no VLM/OCR/semantic naming',
        'sources are live capture / this scope product / managed baseline; no arbitrary path, URL, attachment id or caller base64',
        'products are per workspace scope (16 images, 128 MiB total); page navigation keeps images readable but invalidates act',
        'one delivered PNG per call under the P0 output rules (staging by default, 0600, no-clobber); evidence.vision.version=1',
        'offline baseline list/get/delete and product sources never start Chromium; live sources and act do',
        'T4 dynamic behaviour is implemented separately: see capabilities.dynamic (frames, analysis, correlation)',
      ];
      const diagnosticConstraints = ['diagnostic call; never starts Chromium or takes ownership'];
      const viewportConstraints = [
        'one shared view per workspace scope: {x,y,width,height,scale,source,revision} in document CSS px',
        'get is a cache diagnostic: no lazy start, no CDP, no lease, no queue; an older cache is reported stale',
        'set is a page operation (lazy start + serial queue + single-owner lease), including a scale-only set',
        'only a width/height change sends Emulation.setDeviceMetricsOverride; scale never changes CSS viewport, DPR or page zoom',
        'expectedRevision gives CAS inside the queue (VIEWPORT_CONFLICT, patch not applied)',
        'x/y are the document scroll position read back from Page.getLayoutMetrics (not cached page values)',
        'canvasX/canvasY are the viewport origin on the document canvas (canvas-css-px); negative and outside-content values are legal, O = C - S is derived',
        'canvasX/canvasY and x/y cannot be combined in one patch (INVALID_ARGUMENT); a new document resets C=S=0',
        'frames carry scrollX/scrollY captured with the frame so the panel can place them in canvas space',
      ];
      const workspaceIsolation = registry.capabilities();
      // TOOL-P1-06: the assertion schema is the core module's exported frozen object (lossless JSON
      // projection). Loading the pure module never starts a page or takes a lease; a broken/missing
      // core degrades to null + limitation instead of failing the whole capability read.
      const assertionSchema = await runtime.dynamicAssertionSchema();
      // P0 capture facts. `observed` only ever comes from a real browser_screenshot of this Runtime
      // (relative paths and numbers only) — this call still starts nothing and takes no lease.
      const observation = runtime.captureObservation;
      // T3 observation: the last real vision call of this Runtime (status/numbers only).
      const visionObservation = runtime.visionObservation;
      const observedCapture = observation && typeof observation === 'object'
        ? {
          observedAt: observation.observedAt,
          scale: observation.scale,
          png: { width: observation.png.width, height: observation.png.height },
          sizeCheck: { ok: observation.sizeCheck.ok === true },
          anomaly: {
            checked: observation.anomaly.checked === true,
            uniform: typeof observation.anomaly.uniform === 'boolean' ? observation.anomaly.uniform : null,
            transparent: typeof observation.anomaly.transparent === 'boolean' ? observation.anomaly.transparent : null,
          },
          delivery: { downscaled: observation.delivery.downscaled === true },
          file: observation.file
            ? { persistence: observation.file.persistence, relativePath: observation.file.relativePath }
            : null,
        }
        : null;
      // The capability matrix below describes the *Web* surface. In another environment it would be
      // a lie: report the environment-scoped truth (adapter.capabilities) and say so, rather than
      // listing web.* entries that this environment does not offer (A13/A08).
      const activeEnvironment = crossEnvironment.snapshotForAgent(exec.agent).environment;
      const webSurface = activeEnvironment === 'web';
      return { ok: true,
        environment: activeEnvironment,
        runtime: {
          running, browser: 'chromium', transport: running ? 'ws' : 'unavailable',
          isolation: 'single-owner-lease', attachments: typeof attachments?.saveImage === 'function',
          scope: runtime.scope,
          // Page-per-workspace isolation only: the Chromium process and the temporary profile
          // (hence cookies/localStorage/cache) are shared. This is not a security boundary.
          workspaceIsolation,
        },
        capabilities: [
          ...pageTools.map((name) => ({ id: 'web.t1.' + name, tool: 'browser_' + name,
            // The legacy traffic snapshot is a read-only metadata read: it neither takes nor
            // validates the single-owner lease, so another owner's BUSY never applies to it.
            status: name === 'network' ? 'available' : (busy ? 'unavailable' : 'available'),
            ...(name !== 'network' && busy ? { reason: 'BUSY: browser owned by another session' } : {}),
            ...(name === 'network' ? { reason: null, constraints: [...pageConstraints, 'read-only: no page queue and no single-owner lease'] } : { constraints: pageConstraints }) })),
          ...t2Tools.map((name) => ({ id: 'web.t2.' + name, tool: 'browser_' + name,
            status: busy ? 'unavailable' : 'available',
            ...(busy ? { reason: 'BUSY: browser owned by another session' } : {}),
            constraints: t2Constraints })),
          ...t3Tools.map((name, index) => ({ id: t3CapabilityIds[index], tool: 'browser_' + name,
            status: busy ? 'unavailable' : 'available',
            ...(busy ? { reason: 'BUSY: browser owned by another session' } : {}),
            constraints: t3Constraints })),
          ...diagnosticTools.map((name) => ({ id: 'web.t1.' + name, tool: 'browser_' + name, status: 'available', constraints: diagnosticConstraints })),
          // Shared viewport (docs/viewport-control.md): get stays readable even when another
          // session owns the page; set is a page operation and reports BUSY like every other one.
          { id: 'web.t1.viewport', tool: 'browser_viewport',
            status: busy ? 'unavailable' : 'available',
            ...(busy ? { reason: 'BUSY: browser owned by another session (get 仍可只读诊断)' } : {}),
            constraints: viewportConstraints },
          // P0-D annotations (docs/viewport-control.md): the document lives on the Host side, so
          // neither reading nor drawing waits for another session's page lease. `draw/erase/clear`
          // refuse with ANNOTATION_NOT_FOREGROUND unless a human is displaying that tab.
          { id: 'web.p0d.annotations', tool: 'browser_annotation', status: 'available',
            constraints: [
              'One document per Runtime, shared with the human panel (read-modify-write; the panel hydrates newer Host revisions)',
              'read never needs the foreground; draw/erase/clear need a fresh human-foreground claim ('
                + ANNOTATION_FOREGROUND_TTL_MS + 'ms) for the target tab, else ANNOTATION_NOT_FOREGROUND with zero writes',
              'Host-side only: no page queue, no single-owner lease, no ensure, no page DOM/CSS/lastError change',
              'Same soft limits as the panel write surface ('
                + ANNOTATION_LIMITS.maxShapes + ' shapes / ' + ANNOTATION_LIMITS.maxPointsPerDocument
                + ' points / ' + ANNOTATION_LIMITS.maxDocumentBytes + ' bytes); truncation is deterministic and reported',
            ] },
          { id: 'web.p0e.tabs', tool: 'browser_tabs', status: 'available',
            constraints: [
              'P0-E page group: primary + up to 3 child tabs per workspace (4 total; global maxPages still 8)',
              'list/current are read-only and do not start Chromium or take a lease; select claims an idle tab atomically; open creates about:blank and selects it',
              'close only accepts a tab this Agent session holds a valid lease for; TAB_NOT_FOUND/TAB_LIMIT/TAB_FORBIDDEN/BUSY',
              'Each Agent session has its own selectedTab; all other browser_* tools follow it, defaulting to primary; GUI active tab is independent',
              'BUSY is per tab: different tabs may run concurrently, different owners on one tab conflict; GUI may preview but page writes/input are BUSY',
            ] },
          { id: 'web.t1.workspace-isolation', status: 'available',
            constraints: [
              'One headless Chromium + temporary profile for the plugin; one independent page target per workspace',
              'Isolated per page: URL/title/history, viewport, frame source, network buffer, queue, lease, error, metrics',
              'NOT isolated: cookies, localStorage and cache are shared inside the single profile',
              'At most ' + workspaceIsolation.maxPages + ' page instances; idle ' + workspaceIsolation.idleMs + 'ms sweep; RUNTIME_LIMIT when full',
            ] },
          { id: 'web.t1.http-request', tool: 'browser_http_request', status: 'available',
            constraints: [
              'Host HTTP(S) client; no Chromium startup, page queue or owner lease',
              'No cookie jar or page credentials; caller headers are explicit',
              'Target URLs and DNS checked before every dispatch; redirects are manual and opt-in',
              'Response bytes are bounded; body may be truncated; no automatic decompression',
            ] },
          { id: 'web.t2.structured-dom',
            status: busy ? 'unavailable' : 'available',
            ...(busy ? { reason: 'BUSY: browser owned by another session' } : {}),
            constraints: [
              'Accessibility.getFullAXTree + DOM identity: snapshot -> ref -> action -> before/after evidence',
              'Targets are the two exclusive plain strings ref / selector; selector must be unique in the main document',
              'AX-backed refs reach open shadow roots; iframes are boundary leaves only (no internal ref)',
              'Form support: textbox/checkbox/radio via trusted CDP input, combobox/slider via native setters (dom-control)',
              'No visual/pixel judgement: layout, occlusion cause or visual readability still needs T3; motion needs T4',
            ] },
          { id: 'web.t3.static-vision',
            status: busy ? 'unavailable' : 'available',
            ...(busy ? { reason: 'BUSY: browser owned by another session' } : {}),
            constraints: t3Constraints },
          ...networkTools.map((name) => {
            const mutating = name === 'session' || name === 'control';
            const blocked = mutating && busy;
            return {
              id: 'web.network.' + name,
              tool: 'browser_network_' + name,
              status: blocked ? 'unavailable' : 'available',
              ...(blocked ? { reason: 'BUSY: browser owned by another session' } : {}),
              constraints: networkConstraints,
            };
          }),
          { id: 'web.network.p0',
            status: busy ? 'unavailable' : 'available',
            ...(busy ? { reason: 'BUSY: browser owned by another session' } : {}),
            constraints: [
              ...networkConstraints,
              'partial: iframe/OOPIF/dedicated worker only; shared/service worker refused when attribution is unprovable',
              'HTTPS capture is mechanism-identical (same Network domain) but NOT independently verified (no local TLS target)',
            ] },
          // FR-11 Cookie Store (cookie-store.js): metadata is a plain CDP read of the current
          // tab's exact origin; export/import additionally need a *human-issued* approval record
          // (security-approvals.json in the plugin config dir) bound to
          // workspace/runtime/tab/origin, one-shot, with expiry, and with allowHttpOnly:true for
          // HttpOnly entries. No Agent-supplied confirm string participates anywhere.
          { id: 'web.p0.cookies.metadata', tool: 'browser_cookies',
            status: busy ? 'unavailable' : 'available',
            ...(busy ? { reason: 'BUSY: browser owned by another session' } : {}),
            constraints: [
              'Exact same-origin only (protocol+host+port of the current tab); same-site is refused',
              'metadata returns a whitelist projection (name/domain/path/expires/secure/httpOnly/sameSite/...); value is structurally excluded',
              'CDP Network.getCookies({urls:[origin]}); no Storage.getCookies fallback',
            ] },
          { id: 'web.p0.cookies.export', tool: 'browser_cookies',
            status: busy ? 'unavailable' : 'available',
            ...(busy ? { reason: 'BUSY: browser owned by another session' } : {}),
            constraints: [
              'Requires a human-issued approval record (security-approvals.json) matching workspace/runtime/tab/origin exactly; one-shot; expiry enforced',
              'HttpOnly cookies need allowHttpOnly:true in the approval record; the Agent confirm string is never accepted',
              'Plaintext is written only to the controlled file (persistent root, traversal-safe, atomic no-clobber, POSIX 0600)',
              'Over-budget exports fail whole (no truncation, no partial snapshot); tool response/log/network evidence stay value-free (canary-checked)',
            ] },
          { id: 'web.p0.cookies.import', tool: 'browser_cookies',
            status: busy ? 'unavailable' : 'available',
            ...(busy ? { reason: 'BUSY: browser owned by another session' } : {}),
            constraints: [
              'Accepts only this tool\'s export snapshot (kind/version checked); HttpOnly entries need importHttpOnly:true',
              'Backfills via CDP Network.setCookie onto the current tab origin; failed entries are counted, never returned',
            ] },
          // FR-03/FR-04 JavaScript static analysis (script-analysis.js). Debugger.enable is an
          // invasive, opt-in capability: `list` reports armed:false rather than pretending the
          // page has no scripts, and every restore result carries a confidence/status label.
          { id: 'web.p0.scripts.inventory', tool: 'browser_script',
            status: busy ? 'unavailable' : 'available',
            ...(busy ? { reason: 'BUSY: browser owned by another session' } : {}),
            constraints: [
              'Debugger domain is opt-in per Runtime (armed=true); it is never enabled by a read',
              'Inventory carries scriptId/url/source-kind/bytes/has-SourceMap/sha256 — never script content',
              'Source Map presence is an observation; reachability is a separate three-state check',
            ] },
          { id: 'web.p0.scripts.analysis', tool: 'browser_script',
            status: busy ? 'unavailable' : 'available',
            ...(busy ? { reason: 'BUSY: browser owned by another session' } : {}),
            constraints: [
              'Formatting declares isOriginalSource:false and returns a per-line original position map',
              'String recovery labels decoded / plain / unknown; an undecodable entry is never fabricated',
              'Source-to-sink confidence high/medium/low; low means the sink was found without a data source and must not be reported as exploitable',
              'Static analysis never executes page code: array rotation and dynamic indexing need runtime verification',
            ] },
          // FR-02 Attack Surface Discovery: the inventory is built from collector events + a
          // fixed DOM extraction. Evidence levels are the contract (observed/inferred/unverified).
          { id: 'web.p0.surface.discovery', tool: 'browser_surface',
            status: busy ? 'unavailable' : 'available',
            ...(busy ? { reason: 'BUSY: browser owned by another session' } : {}),
            constraints: [
              'observed requires real network traffic: start a network session before building',
              'forms are inferred (DOM can initiate) and caller-supplied paths stay unverified',
              'transports separates declared-but-not-observed from unsupported (DISC-06)',
            ] },
          // FR-09/FR-10 Findings + rules: pure Host memory, so they never wait for a page.
          { id: 'web.p0.findings.model', tool: 'browser_findings', status: 'available',
            constraints: [
              'status is DERIVED from the evidence basis: static-pattern→potential, observed-once→likely, differential/reproduced with >=2 reproductions + contrast→confirmed',
              'a caller-requested higher status is downgraded and the reason is recorded in notes',
              'High/Critical evidence completeness is a hard bar (100%) and is reported per finding',
            ] },
          // FR-08 Business logic: invariants over observed SERVER state.
          { id: 'web.p0.business.logic', tool: 'browser_biz',
            status: busy ? 'unavailable' : 'available',
            ...(busy ? { reason: 'BUSY: browser owned by another session' } : {}),
            constraints: [
              'judgements read the resulting server state, never "the request was accepted"',
              'every probe dispatch passes the same scope gate (origin/path/budget/danger)',
              'a confirmed business problem needs >=2 reproducible observations (BIZ-05)',
            ] },
          // FR-01 Scope & Safety Controller: a session-scoped authorization boundary. Not
          // configured = not active (plain GUI testing unaffected); configured = every dispatch
          // (navigate incl. landed URL, cookie-export CDP reads) is checked pre-dispatch.
          { id: 'web.p0.security.scope', tool: 'browser_security_scope',
            status: busy ? 'unavailable' : 'available',
            ...(busy ? { reason: 'BUSY: browser owned by another session' } : {}),
            constraints: [
              'Exact-origin allowlist (protocol+host+port), optional path-prefix constraints',
              'Budget: maxRequests / maxConcurrent / timeWindowMs; over-budget = 0 dispatches',
              'passive mode refuses active dispatches; active mode needs an explicit set (audit-recorded)',
              'stop is idempotent and irreversible: 0 new dispatches afterwards; a new session is required to reconfigure',
              'Every accept/reject writes an audit entry (actionId, reason code); status never exposes exploration URLs',
            ] },
          // Web T4 dynamic behaviour (docs/t4-dynamic-behavior.md): one entry per REAL
          // registered tool, plus one aggregate alias. M1 registers exactly three tools; a name that
          // is not registered yet cannot be reported as available.
          ...['dynamic-session', 'motion-observe', 'motion-analyze', 'motion-control', 'correlate']
            .map((name) => ({
              name,
              toolName: {
                'dynamic-session': 'browser_dynamic_session',
                'motion-observe': 'browser_motion_observe',
                'motion-analyze': 'browser_motion_analyze',
                'motion-control': 'browser_motion_control',
                'correlate': 'browser_dynamic_correlate',
              }[name],
            }))
            .filter(({ toolName }) => DYNAMIC_REGISTERED_TOOLS.includes(toolName))
            .map(({ name, toolName }) => {
              const registered = DYNAMIC_REGISTERED_TOOLS.includes(toolName);
              const mutating = name === 'dynamic-session' || name === 'motion-control';
              const blocked = registered && mutating && busy;
              return {
                id: 'web.t4.' + name,
                tool: toolName,
                status: !registered ? 'unsupported' : (blocked ? 'unavailable' : 'available'),
                ...(!registered ? { reason: 'not-registered' } : (blocked ? { reason: 'BUSY: browser owned by another session' } : {})),
                constraints: dynamicCapabilityConstraints(name),
              };
            }),
          { id: 'web.t4.dynamic-behavior', status: 'available', tool: null,
            constraints: [
              'aggregate of the T4 group; this is NOT a tool and does not add to the tool count',
              'registered tools: ' + DYNAMIC_REGISTERED_TOOLS.join(', '),
              ...(DYNAMIC_TOOL_NAMES.some((name) => !DYNAMIC_REGISTERED_TOOLS.includes(name))
                ? ['not implemented yet: ' + DYNAMIC_TOOL_NAMES.filter((name) => !DYNAMIC_REGISTERED_TOOLS.includes(name)).join(', ')]
                : []),
              'DV/DN/DC acceptance is tracked separately; a fixture pass is not a T4 implementation pass',
            ] },
          { id: 'web.t4.dynamic-vision', status: 'available', aliasOf: 'web.t4.dynamic-behavior',
            constraints: ['legacy alias of web.t4.dynamic-behavior; not an independent tool', 'tool count unchanged'] },
          // Discovery/selection is always registered and page-independent; the capability matrix
          // must advertise it so "every registered tool has a declaration" stays true.
          { id: 'web.tools.discovery', tool: DISCOVERY_TOOL, status: 'available',
            constraints: [
              'does not start a browser, take a lease, or touch a page',
              'returns capability-group names and candidate tool names only, never withheld schemas',
              'stays available while the Web environment is disabled, together with the two diagnostics',
            ] },
          { id: 'web.t1.browser-extras', status: 'unsupported', reason: 'Not implemented' },
        ].filter(() => webSurface),
        capabilitiesNote: webSurface
          ? null
          : 'capabilities 描述的是 Web 专属操作面；当前环境不是 web，请以 adapter.capabilities / adapter.p0 为准',
        // TOOL-P1-03 caps-level disclosure: measured beats requested, and low sampling can never
        // prove a negative. Same rule the T4 analyzers enforce in metrics.sampling/verdict.
        limitations: [
          'T4 实际采样率以 sampling.measured 为准；requested 只是请求值，不能当作保证',
          '低采样/无采样不得证明“无异常”或“未发生”；证据不足必须返回 INCONCLUSIVE/BLOCKED',
          'screenshot-loop 为 host-scheduled（单飞，受抓图耗时限制）；screencast 为 damage-driven（间隔不均匀）',
          'sampling 采样窗口有界（最多 ' + DYNAMIC_INTERNAL.samplingTraceMax + ' 个已存帧），截断时带 limitation',
        ],
        // Web T4 dynamic behaviour (docs/t4-dynamic-behavior.md). Declared, not probed: reading this
        // starts no page, samples no frame and creates no session. The only module load is the pure
        // dynamic-t4.js import needed for `assertions` (assertionSchema) and it is best-effort.
        dynamic: (() => {
          const observed = runtime.dynamic.observed;
          return {
            version: 1,
            milestone: DYNAMIC_MILESTONE,
            tools: [...DYNAMIC_REGISTERED_TOOLS],
            toolNames: [...DYNAMIC_TOOL_NAMES],
            visual: {
              sources: [...DYNAMIC_SOURCES],
              screencast: { available: true, encoding: 'jpeg', precisePixelAnalysis: false, sharedWithPreview: true },
              screenshotLoop: {
                available: true, encoding: 'png',
                sampleIntervalMs: [DYNAMIC_LIMITS.sampleIntervalMsMin, DYNAMIC_LIMITS.sampleIntervalMsMax],
                precisePixelAnalysis: true, sourceTimestamp: null, singleFlight: true,
              },
              precisePixelAnalysis: 'screenshot-loop-only',
              // Contract §8: the capability report must say that observe can crop on delivery.
              observationDelivery: {
                region: true,
                regionSpace: 'image-px',
                cropOnDelivery: true,
                cropFormat: 'png',
                requiresIncludeImages: true,
                fullFrameDeliveryDecode: false,
                maxImages: T4_LIMITS.maxImagesPerObserve,
                masks: false,
              },
              adapters: runtime.dynamic.controlAdapters ? [...runtime.dynamic.controlAdapters] : [],
              algorithms: assertionSchema ? [...assertionSchema.types] : [...DYNAMIC_ASSERTION_TYPES],
              limitations: runtime.dynamic.conflicts.length ? [...runtime.dynamic.conflicts] : [],
            },
            // TOOL-P1-06: machine-readable assertion contract. This is the core module's own frozen
            // MOTION_ASSERTION_SCHEMA projected losslessly to plain JSON (no functions/undefined).
            assertions: assertionSchema
              ? {
                ...dynamicJsonProjection(assertionSchema),
                idPattern: '^[\\s\\S]{1,64}$',
                idPatternNote: 'Host enforces a non-empty UTF-8 string with byteLength ≤ '
                  + assertionSchema.idMaxBytes + '; the regex is a code-point approximation',
              }
              : null,
            assertionsUnavailable: assertionSchema
              ? null
              : (runtime.dynamic.assertionSchemaUnavailable || 'core-not-loaded'),
            // TOOL-P1-03: requested vs measured sampling semantics. Reading this never samples.
            sampling: {
              version: 1,
              mechanisms: ['screenshot-loop', 'screencast', 'network-only'],
              cadence: {
                'screenshot-loop': 'host-scheduled',
                screencast: 'damage-driven',
                'network-only': 'none',
              },
              requested: {
                screenshotLoop: {
                  intervalMs: [DYNAMIC_LIMITS.sampleIntervalMsMin, DYNAMIC_LIMITS.sampleIntervalMsMax],
                  source: 'setInterval(host)',
                  note: 'request only; actual cadence can be slower (single-flight + capture cost)',
                },
                screencast: {
                  intervalMs: null,
                  source: 'cdp-screencast(damage-driven)',
                  note: 'no requested interval; frames arrive per page damage',
                },
              },
              measured: {
                from: {
                  'screenshot-loop': 'loop-tick-start',
                  screencast: 'frame-timeline',
                  'network-only': null,
                },
                fields: ['frames', 'intervals', 'p50Ms', 'p95Ms', 'minMs', 'maxMs', 'meanMs', 'windowMs', 'effectiveFps', 'from'],
                semantics: 'actual sampling cadence computed from the SAME stored frames returned by browser_motion_observe: screenshot-loop uses the frame receivedMonoMs recorded at loop tick start, screencast uses frame timelineMs; requested is NOT a guarantee',
                boundedSamples: DYNAMIC_INTERNAL.samplingTraceMax,
              },
              counters: ['sampled', 'dropped', 'evicted', 'samplingFailures'],
              limitations: [
                'measured 数据不足时字段为 null 并带 limitation；null/低采样不得证明“无异常/未发生”',
                'screenshot-loop 单飞且受抓图耗时限制，实测 effectiveFps 可能低于 requested intervalMs',
                'screencast 为 damage-driven，间隔不均匀，timeline 间隔不等于渲染帧间隔',
                '采样窗口有界（最多 ' + DYNAMIC_INTERNAL.samplingTraceMax + ' 个已存帧），超出时带 sampling-window-bounded',
              ],
            },
            networkReuse: {
              tools: ['browser_network_session', 'browser_network_events', 'browser_network_detail',
                'browser_network_trace', 'browser_network_control', 'browser_network_evidence',
                'browser_network_subscribe'],
              startsNetwork: false, resetsNetwork: false, subTargets: 'partial',
            },
            correlation: {
              algorithmVersion: 'dc-draft-v1',
              directions: [...DYNAMIC_DIRECTIONS],
              basis: [...DYNAMIC_BASES],
              gradeMap: {
                explicit: 'confirmed-causal', redirect: 'confirmed-causal', initiator: 'confirmed-causal',
                observed: 'observed-association', temporal: 'temporal-proximity',
              },
              confidence: ['direct', 'supported', 'weak', 'unknown'],
              includeTemporalDefault: false,
            },
            limits: { ...DYNAMIC_LIMITS },
            observed: observed && typeof observed === 'object'
              ? {
                observedAt: observed.observedAt, operation: observed.operation,
                dynamicSessionId: observed.dynamicSessionId, motionSessionId: observed.motionSessionId,
                source: observed.source, encoding: observed.encoding, frames: observed.frames,
                highWater: observed.highWater, verdict: observed.verdict,
                integrity: observed.integrity, restoreStatus: observed.restoreStatus,
              }
              : null,
          };
        })(),
        // P0 capture infrastructure (docs/capture-p0.md). Declared, not probed: reading this must
        // never start Chromium, create a page or take the lease. `observed` is the last real
        // browser_screenshot of this Runtime (null until one succeeded).
        capture: {
          version: 1,
          transport: 'cdp-page-capture-screenshot',
          format: 'png',
          coordinateSpace: 'document-css-px',
          // An omitted scale is resolved from the shared view.scale inside the call, so `defaultScale`
          // is the cold fallback (1) and NOT the lower bound of the legal range.
          defaultScaleSource: 'view.scale',
          defaultScale: VIEW_LIMITS.default.scale,
          scaleRange: [CAPTURE_LIMITS.scaleMin, CAPTURE_LIMITS.scaleMax],
          viewScaleRange: [...VIEW_LIMITS.scale],
          maxOutputPixels: CAPTURE_LIMITS.maxOutputPixels,
          supports: {
            region: true,
            clipScale: true,
            captureBeyondViewport: true,
            pngStructureCheck: true,
            blankCheck: true,
            fileWrite: true,
            noClobber: true,
            attachmentSizeCompare: true,
          },
          output: {
            persistRules: [...CAPTURE_PERSIST_RULES],
            defaultMode: 'staging',
            stagingRoot: '<tmp>/dsh-ui-testing-capture-*',
            workspaceRoot: '<workspace>',
            directory: 'output/capture',
            env: 'DSH_UI_TESTING_CAPTURE_DIR',
            mode: '0600',
            noClobber: true,
            ephemeral: true,
          },
          limits: { maxRegionPixels: CAPTURE_LIMITS.maxOutputPixels },
          observed: observedCapture,
        },
        // Shared viewport (docs/viewport-control.md). Declared, never probed: reading this
        // starts nothing and takes no lease. `observed` only comes from a real Page.getLayoutMetrics
        // readback (numbers only, no page text, no absolute path).
        viewport: {
          version: 1,
          tool: 'browser_viewport',
          coordinateSpace: 'document-css-px',
          get: { readOnly: true, lazyStart: false, lease: false, fresh: false },
          set: { lazyStart: true, lease: true },
          deviceScaleFactor: 1,
          pageZoomChanged: false,
          presets: Object.fromEntries(Object.entries(VIEW_PRESETS).map(([mode, size]) => [mode, { ...size }])),
          default: { ...VIEW_LIMITS.default },
          scaleRange: [...VIEW_LIMITS.scale],
          // Canvas space (docs/viewport-control.md): C may be negative / outside the content box;
          // blank is composited by Host/Client and does not exist in the page DOM.
          canvas: {
            version: 1,
            space: 'canvas-css-px',
            range: [...VIEW_LIMITS.canvas],
            blankColor: VIEW_LIMITS.canvasBlankColor,
            compositeProvenance: true,
          },
          observed: (() => {
            const observed = runtime.observedProjection();
            return observed === null ? null : {
              revision: runtime.view.revision,
              source: runtime.view.source,
              observedAt: observed.observedAt,
              stale: runtime.viewMeta().stale,
            };
          })(),
        },
        // Web T3 static vision (docs/t3-vision.md). Declared, never probed: reading this must
        // not start Chromium, create the baseline root or add a product. `observed` is the last real
        // vision call of this Runtime and never contains an image, an absolute path or page text.
        vision: {
          version: 1,
          algorithmVersion: T3_ALGORITHM_VERSION,
          tools: [...T3_TOOL_NAMES],
          sourceKinds: [...T3_SOURCE_KINDS],
          limits: {
            maxProducts: T3_LIMITS.maxProducts,
            maxTotalBytes: T3_LIMITS.maxTotalBytes,
            maxProductBytes: T3_LIMITS.maxProductBytes,
            maxProductPixels: T3_LIMITS.maxProductPixels,
            maxWorkingSetBytes: T3_LIMITS.maxWorkingSetBytes,
            maxTemplateComparisons: T3_LIMITS.maxTemplateComparisons,
            algorithmBudgetMs: T3_LIMITS.algorithmBudgetMs,
            maxOutputPixels: T3_LIMITS.maxOutputPixels,
            maxOutputBytes: T3_LIMITS.maxOutputBytes,
            maxEvidenceBytes: T3_EVIDENCE_BYTES,
            maxEvidenceRegions: T3_EVIDENCE_REGIONS,
            maxCases: T3_MAX_CASES,
            maxAssertionsPerCase: T3_MAX_ASSERTIONS,
            maxFactsPerCase: T3_MAX_FACTS,
            maxMasks: T3_MAX_MASKS,
            maxAnnotations: T3_MAX_ANNOTATIONS,
            maxPreprocess: T3_MAX_PREPROCESS,
            actMaxAgeMs: T3_ACT_MAX_AGE_MS,
          },
          observed: visionObservation && typeof visionObservation === 'object'
            ? {
              observedAt: visionObservation.observedAt,
              lastOperation: typeof visionObservation.lastOperation === 'string' ? visionObservation.lastOperation : null,
              lastVerdict: typeof visionObservation.lastVerdict === 'string' ? visionObservation.lastVerdict : null,
            }
            : null,
        },
        // P0-D annotations (docs/viewport-control.md). Declared, never probed: reading this
        // starts nothing. Two writers share ONE document: the human panel over the authenticated
        // scoped route, and the Agent over `browser_annotation` (which additionally needs a fresh
        // human-foreground claim for the target tab).
        annotations: {
          version: ANNOTATION_VERSION,
          space: ANNOTATION_SPACE,
          readTool: 'browser_state',
          readPath: 'annotations',
          readTools: ['browser_state', 'browser_annotation'],
          writeSurface: 'authenticated-scoped-http',
          writeRoute: 'POST /plugins/ui-testing/annotations',
          writeTool: 'browser_annotation',
          writeActions: ['draw', 'erase', 'clear'],
          writeModel: 'read-modify-write of one document; the panel hydrates a newer Host revision',
          foregroundRequiredForWrite: true,
          foregroundTtlMs: ANNOTATION_FOREGROUND_TTL_MS,
          source: 'human-panel',
          trusted: false,
          screenshotOverlay: true,
          screenshotTool: 'browser_screenshot',
          screenshotParameter: 'includeAnnotations',
          screenshotDefault: false,
          coordinateSpace: 'canvas-css-px',
          // d = a shape's canvas point; q = d − C, O = C − S, page-viewport p = q + O = d − S. The
          // published `view` is the panel's accepted snapshot, not a live truth: read the current S
          // before dispatching, and never dispatch when d is outside the content box or p is outside
          // the current viewport. scale and the host DPR never enter p.
          coordinateHint: 'd 为画布 CSS px；q=d-C、O=C-S、页面视口 p=q+O=d-S；派发前必须读取当前 S 再换算，旧快照不是当前命中；d 在内容盒外或 p 在当前视口外时不能派发；scale 与宿主 DPR 不进入 p',
          reset: 'documentKey 在主文档提交、主上下文清除、同文档主框架 URL/hash/history 变化、close 与 CDP 断连时轮换并清空标注',
          staleAfterMs: ANNOTATION_LIMITS.staleAfterMs,
          limits: annotationLimits(),
          observed: (() => {
            const document = runtime.annotationsDocument();
            return {
              revision: document.revision,
              updatedAt: document.updatedAt,
              shapeCount: document.shapes.length,
              stale: document.stale,
              staleReason: document.staleReason,
              // Whether `browser_annotation` could write right now (a human displays this tab).
              foreground: document.foreground.active,
              foregroundAgeMs: document.foreground.ageMs,
            };
          })(),
        },
        // P0-E multi-tab surface (docs/internal/p0e-multitab-contract.md). Declared, no probe.
        tabs: (() => {
          const registry = runtime.registry;
          const entry = registry && typeof registry.entryForRuntime === 'function' ? registry.entryForRuntime(runtime) : undefined;
          const primary = entry && registry.primaryEntry(entry);
          const selection = primary ? registry.selectionFor(primary, exec.meta.sessionId) : { tabId: 'primary' };
          const idleMs = registry ? registry.idleMs : IDLE_MS_DEFAULT;
          return {
            version: 1,
            tools: ['browser_tabs'],
            actions: ['list', 'current', 'select', 'open', 'close', 'wait'],
            maxTabsPerWorkspace: 4,
            maxChildTabs: 3,
            maxGlobalPages: registry ? registry.maxPages : MAX_PAGES_DEFAULT,
            idleMs,
            noticesLimit: registry ? registry.noticesLimit : POPUP_NOTICES_LIMIT,
            closedHistoryLimit: registry ? registry.closedHistoryLimit : CLOSED_HISTORY_LIMIT,
            // Any page tool on the tab refreshes its idle timer; list/wait are pure reads.
            keepalive: {
              refreshOnPageTools: true, idleMs,
              note: '任一页面工具在该标签上成功执行都会刷新它的 idle 计时；list/wait 不刷新，也不启动 Chromium/不取 lease',
            },
            selectedTab: selection.tabId,
            selectionIsolation: 'per-agent-session; GUI active is separate',
            busyScope: 'per-tab',
            state: {
              views: primary ? registry.listTabs(primary, exec.meta.sessionId) : [],
            },
          };
        })(),
        // Web P0 network (docs/network-p0.md). Declared, never probed.
        network: (() => {
          const caps = network.networkCapabilities(runtime.net, { control: runtime.netCtl, subTargets: NETWORK_SUBTARGETS });
          return {
            ...caps,
            session: busy && runtime.net.session
              ? { ...caps.session, state: caps.session.state }
              : caps.session,
          };
        })(),
        limits: {
          viewport: {
            ...runtime.viewport,
            version: 1,
            width: [...VIEW_LIMITS.width],
            height: [...VIEW_LIMITS.height],
            scroll: [...VIEW_LIMITS.scroll],
            canvas: {
              version: 1,
              space: 'canvas-css-px',
              range: [...VIEW_LIMITS.canvas],
              blankColor: VIEW_LIMITS.canvasBlankColor,
              compositeProvenance: true,
            },
            scale: [...VIEW_LIMITS.scale],
            default: { ...VIEW_LIMITS.default },
            presets: Object.fromEntries(Object.entries(VIEW_PRESETS).map(([mode, size]) => [mode, { ...size }])),
            scrollPollMinMs: VIEW_LIMITS.scrollPollMinMs,
            staleAfterMs: VIEW_LIMITS.staleAfterMs,
            settleMaxMs: VIEW_LIMITS.settleMaxMs,
            deviceScaleFactor: 1,
            pageZoomChanged: false,
          },
          // P0-D annotations (docs/viewport-control.md): the soft limits the Host enforces and
          // the client applies to the same normalized set.
          annotations: annotationLimits(),
          networkEntries: NETWORK_LIMIT,
          tabs: {
            maxTabsPerWorkspace: 4, maxChildTabs: 3, maxGlobalPages: registry.maxPages,
            actions: ['list', 'current', 'select', 'open', 'close', 'wait'],
            idleMs: registry.idleMs,
            noticesLimit: registry.noticesLimit,
            closedHistoryLimit: registry.closedHistoryLimit,
            keepalive: {
              refreshOnPageTools: true, idleMs: registry.idleMs,
              note: '任一页面工具在该标签上成功执行都会刷新它的 idle 计时；list/wait 不刷新，也不启动 Chromium/不取 lease',
            },
          },
          network: {
        ...network.limitsView(),
        availability: 'declared',
        // §8.8 capability flags (booleans) + numeric bounds in the *Limits objects.
        capture: true, bodies: true, websocket: true, sse: true, workers: true,
        interception: true, throttle: true, offline: true, replay: true, mock: true,
        har: true, jsonl: true, subscriptions: true,
        https: 'mechanism-identical',
        responseModification: runtime.netCtl.responseModification === true,
        subTargets: NETWORK_SUBTARGETS,
        // TOOL-P1-04 (docs/network-p0.md): declared facts only, never probed here. Body failures
        // carry a stable reason code; session attribution is per tab and never inferred.
        bodyStates: {
          states: ['captured', 'empty', 'unavailable'],
          unavailableReason: 'NET_BODY_UNAVAILABLE',
          reasonCodes: [...network.NET_BODY_REASON_CODES],
          reasonCodeFields: ['reasonCode', 'reasonDetail'],
          captureBodiesFalseReason: 'not-captured',
        },
        attribution: { fields: ['scopeId', 'runtimeId', 'tabId'], missingIsNull: true, noInference: true, crossTabAggregation: false },
        sessionConsistency: { activeSessionId: true, bufferedEvents: true, sessionlessEventsEmpty: true, divergenceRootCause: 'UNKNOWN' },
        throttleLimits: { latencyMsMax: 60000, downloadKbpsMax: 1000000, uploadKbpsMax: 1000000, unit: 'Kbps = 1024 bit/s' },
        holdLimits: { maxHeld: network.NET_LIMITS.held, timeoutMs: network.NET_LIMITS.holdTimeoutMs },
        ruleLimits: { max: network.NET_LIMITS.rules, kinds: [...network.NET_RULE_KINDS] },
        subTargetsDetail: {
          // Measured on this build (real headless Chromium + /web-network.html):
          //  - dedicated worker: attached at the page level, requests captured with their own targetId
          //  - service worker: NOT attached — a page-level attach pauses it at start
          //    (waitForDebuggerOnStart) and makes `serviceWorker.register()`/`controller` fail, i.e.
          //    collection would change page semantics, so it is refused by design.
          //  - shared worker: page-level attach entry is armed, but this build attaches nothing
          //    observable for it (the fixture's `/n/worker-data` stays uncaptured).
          //  - OOPIF: same-origin iframe target captured; cross-site OOPIF is NOT separately verified.
          workers: 'page-attached',
          shared_worker: 'not-collected',
          service_worker: 'not-collected',
          oopif: 'partial',
          partial: true,
          reason: 'attaching a service_worker target pauses it at start and breaks serviceWorker.register()/controller, so it is refused; popup targets stay blocked; cross-site OOPIF not separately verified',
        },
      },
          screenshot: typeof attachments?.saveImage === 'function' ? 'attachment' : 'base64-fallback',
          leaseIdleMs: AGENT_HOLD_MS,
          scope: { id: runtime.scope.id, workspaceId: runtime.scope.workspaceId, degraded: runtime.scope.degraded },
          workspaceIsolation,
          capture: {
            scaleRange: [CAPTURE_LIMITS.scaleMin, CAPTURE_LIMITS.scaleMax],
            defaultScaleSource: 'view.scale',
            defaultScale: VIEW_LIMITS.default.scale,
            scale: 'explicit: continuous 0.1-4 (fractions allowed); omitted: the shared view.scale; output = round(css x scale)',
            minOutputPixels: { width: CAPTURE_LIMITS.minOutputPixels, height: CAPTURE_LIMITS.minOutputPixels },
            maxOutputPixels: CAPTURE_LIMITS.maxOutputPixels,
            maxRegionPixels: CAPTURE_LIMITS.maxOutputPixels,
            maxPathBytes: 200,
            maxSegmentBytes: 100,
            extension: '.png',
            fileMode: '0600',
            noClobber: true,
            staging: true,
            persistParam: true,
            pathKind: ['relative', 'absolute'],
            persistRules: [...CAPTURE_PERSIST_RULES],
            defaultName: 'output/capture/<actionId>.png',
            env: 'DSH_UI_TESTING_CAPTURE_DIR',
            warnings: [...CAPTURE_WARNING_VOCABULARY],
          },
          // Web T4 dynamic limits: the frozen T4_LIMITS object, projected verbatim
          // (docs/t4-dynamic-behavior.md).
          dynamic: { ...DYNAMIC_LIMITS },
          vision: {
            algorithmVersion: T3_ALGORITHM_VERSION,
            coordinateSpaces: { image: 'image-px', document: 'document-css-px', input: 'viewport-css-px' },
            sourceKinds: [...T3_SOURCE_KINDS],
            productIdPattern: '^v1_[0-9a-f]{32}$',
            productKinds: ['capture', 'derived', 'diff', 'baseline'],
            maxProducts: T3_LIMITS.maxProducts,
            maxTotalBytes: T3_LIMITS.maxTotalBytes,
            maxProductBytes: T3_LIMITS.maxProductBytes,
            maxProductPixels: T3_LIMITS.maxProductPixels,
            algorithmBudgetMs: T3_LIMITS.algorithmBudgetMs,
            maxTemplateComparisons: T3_LIMITS.maxTemplateComparisons,
            evidence: { version: 1, maxBytes: T3_EVIDENCE_BYTES, maxRegions: T3_EVIDENCE_REGIONS },
            check: { maxCases: T3_MAX_CASES, maxAssertions: T3_MAX_ASSERTIONS, maxFacts: T3_MAX_FACTS },
            masks: T3_MAX_MASKS,
            annotations: T3_MAX_ANNOTATIONS,
            preprocess: T3_MAX_PREPROCESS,
            act: { maxAgeMs: T3_ACT_MAX_AGE_MS, actions: ['move', 'click', 'drag'] },
            warnings: [...T3_WARNING_VOCABULARY],
            diff: { algorithm: 'yiq-v1', defaultOptions: { ...T3_DEFAULT_DIFF_OPTIONS }, defaultThresholds: { ...T3_DEFAULT_THRESHOLDS } },
            baseline: { root: 'DSH_UI_TESTING_CAPTURE_DIR | workspace', scopeHash: 'sha256(scopeId).slice(0,32)', directory: 'output/vision-baselines', mode: { directory: '0700', file: '0600' }, actions: ['list', 'get', 'create', 'update', 'delete'] },
            observed: visionObservation && typeof visionObservation === 'object'
              ? {
                observedAt: visionObservation.observedAt,
                lastOperation: typeof visionObservation.lastOperation === 'string' ? visionObservation.lastOperation : null,
                lastVerdict: typeof visionObservation.lastVerdict === 'string' ? visionObservation.lastVerdict : null,
              }
              : null,
            notImplemented: ['T4 dynamic vision lives in capabilities.dynamic; this static-vision block does not implement frame sequences'],
          },
          navigation: 'Document URLs and DNS checked; subresources are not a network sandbox',
          structuredGui: {
            protocolVersion: T2_LIMITS.protocolVersion,
            targetFrame: 'main',
            defaultMaxNodes: T2_LIMITS.snapshotDefaultMaxNodes,
            maxNodes: T2_LIMITS.snapshotMaxNodes,
            defaultDepth: T2_LIMITS.snapshotDefaultDepth,
            maxDepth: T2_LIMITS.snapshotMaxDepth,
            boxesDefault: false,
            treeBytes: T2_LIMITS.treeBytes,
            snapshotBytes: T2_LIMITS.snapshotBytes,
            evidenceBytes: T2_LIMITS.evidenceBytes,
            maxRefs: T2_LIMITS.maxRefs,
            refPolicy: 'monotonic-lru',
            formFields: T2_LIMITS.formFields,
            textBytes: T2_LIMITS.formTextBytes,
            formKinds: [...T2_FORM_KINDS],
            scrollAmount: T2_LIMITS.scrollAmount,
            wait: {
              defaultTimeoutMs: T2_LIMITS.waitDefaultTimeoutMs,
              maxTimeoutMs: T2_LIMITS.waitMaxTimeoutMs,
              defaultPollMs: T2_LIMITS.waitDefaultPollMs,
              minPollMs: T2_LIMITS.waitMinPollMs,
              maxPollMs: T2_LIMITS.waitMaxPollMs,
            },
            refLifecycle: 'monotonic refs, LRU 2000; cleared on a main-frame document commit, main-context loss, close and CDP disconnect; same-document pushState/hash keeps refs',
            selectors: 'unique CSS in the main document only; no shadow pierce, no iframe, no XPath/text DSL',
            shadow: 'AX-backed refs reach open shadow roots; hit-test walks open roots',
            iframes: 'boundary-only: the iframe element can be inspected, actions inside it are UNSUPPORTED',
            formControls: 'textbox/checkbox/radio via CDP input; combobox/slider via native setters (dom-control, never isTrusted)',
            noForce: 'no force/JS-click/selector-retry escape hatch; occlusion or instability is a reported failure',
            evidence: 'version=1; editable values and input text are never echoed (value null + valueRedacted)',
            visual: 'no pixel/visual analysis in this tier: T3 static vision and T4 dynamic behaviour are separate tool groups',
            cookies: 'shared with the single Chromium profile (not a security boundary)',
          },
          httpRequest: {
            defaultTimeoutMs: HTTP_DEFAULTS.timeoutMs,
            maxTimeoutMs: HTTP_LIMITS.timeoutMsMax,
            defaultMaxBytes: HTTP_DEFAULTS.maxBytes,
            maxBytes: HTTP_LIMITS.maxBytesMax,
            maxRequestBodyBytes: HTTP_LIMITS.bodyBytes,
            maxRequestHeaderBytes: HTTP_LIMITS.requestHeaderBytes,
            maxResponseHeaderBytes: HTTP_LIMITS.responseHeaderBytes,
            followRedirects: HTTP_DEFAULTS.followRedirects,
            defaultMaxRedirects: HTTP_DEFAULTS.maxRedirects,
            maxRedirects: HTTP_LIMITS.maxRedirectsMax,
            cookies: 'none; no cookie jar or page credentials',
            isolation: 'independent requests; no shared page lease or queue',
            targetPolicy: 'HTTP(S), URL and DNS validation per dispatch; loopback allowed; private ranges require DSH_UI_TESTING_ALLOW_PRIVATE=1; known DSH origins blocked',
            security: 'Not a complete network sandbox; DNS rebinding remains possible; unknown host origins and response content may contain secrets',
          },
        },
        // The per-Agent capability selection: group names and catalog only, never the withheld
        // schemas. `browser_capabilities` is always disclosed, so this stays reachable.
        disclosure: disclosure.status(exec.agent),
        // Cross-environment control plane (M2/M3): the same config revision that admitted this
        // call, the adapter capability matrix and the six-axis readiness. Reading it starts nothing.
        adapter: await crossEnvironment.capabilitiesBlock(
          null,
          liveReadinessTarget(exec, runtime),
          crossEnvironment.snapshotForAgent(exec.agent),
        ),
      };
    },
  });
  /**
   * Apply one authoritative config transition to the *running* resources (A12).
   *
   * Re-admitting the tool surface is not enough: a selection that no longer resolves to Web must
   * also cancel queued/running work, release the connection/frame source/network collector/lease
   * and rotate the tab selection, otherwise an old reference keeps operating a page its
   * environment no longer owns. Only pages whose scope lost Web are touched, so an unrelated
   * write (e.g. enabling the fake environment) never tears down a live Web page.
   *
   * @returns {{transitioned: Array<{scope:string, environment:string, reason:string}>}}
   */
  register({
    name: DISCOVERY_TOOL,
    description: '查看或选择本会话的 UI 测试能力组。默认只提供本工具与诊断工具；'
      + '需要页面操作、网络、静态图像或动态帧分析时先 activate，对应完整工具会在下一步模型请求中出现。'
      + 'action=status|activate|reset；activate 需要 groups。',
    parameters: {
      type: 'object',
      properties: {
        action: { type: 'string', enum: ['status', 'activate', 'reset'], description: 'status 只读；activate 累加能力组；reset 清空本会话选择' },
        groups: {
          type: 'array',
          items: { type: 'string', enum: ['basic', 'network', 'security', 'vision', 'dynamic'] },
          minItems: 1,
          maxItems: 5,
          description: '仅 activate：basic=页面基础操作；network=网络诊断（依赖 basic）；'
            + 'security=Cookie 凭据（依赖 basic，导出需人类授权）；'
            + 'vision=静态图像（依赖 basic）；dynamic=动态帧（依赖 basic，网络关联时另选 network）',
        },
      },
      required: ['action'],
    },
    output: { schema: { type: 'object' }, render: (args, value) => text(value) },
    async execute(args, exec) {
      return disclosure.execute(args, exec.agent);
    },
  });
  register({
    name: 'browser_navigate',
    description: '在调试视图的内嵌浏览器里打开一个 HTTP(S) 地址。',
    parameters: {
      type: 'object',
      properties: { url: { type: 'string', description: '完整地址，必须带 http:// 或 https://' } },
      required: ['url'],
    },
    output: { schema: { type: 'object' }, render: (args, value) => text(value) },
    async execute(args, exec) {
      const target = String((args && args.url) || '').trim();
      return { ok: true, ...await exec.runtime.navigate(target, exec.signal) };
    },
  });
  register({
    name: 'browser_eval',
    description: '在内嵌浏览器的页面上下文里执行 JavaScript 并返回结果（T1 JS 执行能力）。',
    parameters: {
      type: 'object',
      properties: { expression: { type: 'string', description: '表达式或语句，最后一个值会被返回' } },
      required: ['expression'],
    },
    output: { schema: { type: 'object' }, render: (args, value) => text(value) },
    async execute(args, exec) {
      return exec.runtime.evaluate(String((args && args.expression) || 'undefined'), true, exec.signal);
    },
  });
  register({
    name: 'browser_screenshot',
    description: '截取内嵌浏览器的画面（PNG）：默认 canvas 视口 [C,C+W)×[C,C+H)、默认比例 = 当前共享显示比例 view.scale（冷启动 100%）；可选 scale（连续 0.1–4，可用小数；重新光栅化，不是位图放大）、'
      + 'region（canvas CSS 像素矩形；O=0 时与文档坐标相同，可为负 → blank 纯白）、persist（默认 false：写插件暂存目录，不落工作区）、out（工作区相对 .png，提供即视为持久留存）。'
      + '用户提到标注、画、圈、框、箭头或笔迹等面板标注时，传 includeAnnotations:true，把已提交标注按当前画布坐标叠加到截图（含文字和画笔），返回 capture.annotations 版本与来源；默认 false。'
      + 'O≠0 时以真实 S 截页面再白底合成（重编码），证据 capture.canvas.composite=true；O=0 且未叠加标注时保持单次 CDP PNG 不重编码。'
      + '只有 out / persist:true / DSH_UI_TESTING_CAPTURE_DIR 三者之一才持久落盘（0600、原子写入、绝不覆盖）；'
      + '暂存文件返回绝对路径并在插件卸载时删除。返回 PNG 结构/尺寸校验/空白识别/落盘/附件对比证据与 warnings；尺寸不符或 PNG 损坏时不交付图片。',
    parameters: {
      type: 'object',
      properties: {
        scale: {
          type: 'number',
          description: '光栅化倍数（重新光栅化，不是位图放大），连续 0.1–4，可用小数（如 0.65/1.25）。省略 = 使用共享显示比例 view.scale（默认 100% = 1），在调用内解析一次；显式值只影响本次截图，不改 view/DPR/滚动/视口。输出像素 = round(canvas CSS 尺寸 × scale；O=0 时与文档相同)，两轴都须 ≥ 1 像素。高 DPI 只提升 DOM/CSS/文字/矢量，canvas/WebGL 内部位图不会变清晰。',
        },
        region: {
          type: 'object',
          description: 'canvas CSS 像素矩形（O=0 时与文档相同；x/y 可为负 → 该区域为 blank 纯白）；省略 = 当前 canvas 视口 [C,C+W)×[C,C+H)。width/height ≥ 1，期望像素上限 16,000,000（按最终合成图）。',
          properties: {
            x: { type: 'number' },
            y: { type: 'number' },
            width: { type: 'number' },
            height: { type: 'number' },
          },
          required: ['x', 'y', 'width', 'height'],
        },
        includeAnnotations: {
          type: 'boolean',
          description: '默认 false。用户提到标注、画、圈、框、箭头、笔迹等面板标注时设为 true：将当前已提交的圆、矩形、线、箭头、画笔与文字叠加到浏览器截图，按 region/scale 一起裁剪缩放。只含 Host 已接受的标注，不含未提交草稿和面板工具栏；capture.annotations 记录版本、来源、过期与截断状态。标注是人类线索，不是页面事实。',
        },
        persist: {
          type: 'boolean',
          description: '是否持久留存（默认 false）。false/省略 = 写插件暂存目录（返回绝对路径，插件卸载时删除，不落工作区）；true = 持久写入可用根（DSH_UI_TESTING_CAPTURE_DIR，未配置时为工作区）下的 output/capture/<actionId>.png；根不可用则 OUTPUT_PATH_INVALID，不回落。',
        },
        out: {
          type: 'string',
          description: '工作区相对的 .png 路径（如 output/capture/demo.png）；提供即视为持久留存（等价 persist:true，但用这个文件名）。同路径不覆盖，冲突返回 OUTPUT_EXISTS（请换 out）。',
        },
      },
      required: [],
    },
    output: { schema: { type: 'object' }, render: (args, value) => {
      const { image, attachment, ...meta } = value;
      return attachment ? [{ type: 'image', attachment }, ...text(meta)] : text({ ...meta, image });
    } },
    async execute(args, exec) {
      const runtime = exec.runtime;
      // 1) Pure pre-flight: an invalid argument must cost neither a browser nor a file.
      // The network window is measured against wall-clock + the session high-water mark taken
      // *before* the capture starts (docs/network-p0.md / R1-16); it never starts collection.
      const networkStart = { frameTimeMs: Date.now(), highWater: runtime.net ? runtime.net.seq : 0 };
      const request = normalizeCaptureRequest(args);
      // The default density is the shared `view.scale`, resolved ONCE here inside the call (cold
      // view default is 1) — an omitted scale must never be frozen to 1 by the validator
      // (docs/viewport-control.md). An explicit scale overrides it for this capture only: it
      // never writes view/DPR/scroll/viewport.
      const scale = request.scale === null ? runtime.view.scale : request.scale;
      const scaleSource = request.scale === null ? 'view' : 'explicit';
      const viewRevision = runtime.view.revision;
      const budgetRect = request.region
        || { x: 0, y: 0, width: runtime.viewport.width, height: runtime.viewport.height };
      assertCaptureBudget(budgetRect, scale);

      // 2) Persistence + output path, decided before the capture: a rejected `out` must not write a
      // PNG, and the default (no out/persist/env) must never touch the workspace.
      const envRoot = captureEnvRoot();
      const persistent = request.out !== null || request.persist === true || envRoot !== null;
      const defaultName = 'output/capture/' + exec.meta.actionId + '.png';
      let target = null;
      let rootSource = null;
      if (persistent) {
        const rootInfo = captureRootFor(exec);
        if (rootInfo.root === null) {
          throw new BrowserError('OUTPUT_PATH_INVALID', '没有可用的工作区根，无法持久落盘：请省略 out/persist 或设置 DSH_UI_TESTING_CAPTURE_DIR', {
            reason: 'root_unknown', outRequested: request.out !== null, persistRequested: request.persist,
          });
        }
        rootSource = rootInfo.source;
        const resolved = resolveCapturePath({
          root: rootInfo.root,
          out: request.out === null ? undefined : request.out,
          defaultName,
        });
        if (!resolved.ok) throw new BrowserError('OUTPUT_PATH_INVALID', resolved.message, resolved.details);
        target = resolved;
      }

      // 3) The single capture (no retry, no second encoding).
      // A01: the capture data plane goes through the P0 provider (target binding + evidence),
      // while the screenshot tool keeps owning its public result shape.
      const shot = await p0(exec, 'A', 'capture', { scale, region: request.region, scaleSource, includeAnnotations: request.includeAnnotations });
      const data = shot.pngBytes;
      const captured = shot.capture;
      const product = await p0(exec, 'A', 'product');

      const warnings = [];
      const sha256 = createHash('sha256').update(data).digest('hex');
      const requestBlock = {
        scale,
        scaleSource,
        viewRevision,
        region: request.region
          ? { x: request.region.x, y: request.region.y, width: request.region.width, height: request.region.height }
          : null,
        // Canvas space is the default capture space (docs/viewport-control.md). O = 0 keeps the
        // historical document-css-px coordinate space for old consumers; O ≠ 0 is canvas space.
        space: 'canvas-css-px',
        coordinateSpace: captured.composite ? 'canvas-css-px' : 'document-css-px',
        out: request.out,
        persist: request.persist,
        includeAnnotations: request.includeAnnotations,
      };
      const environment = {
        browser: 'chromium',
        headless: typeof product.headless === 'boolean' ? product.headless : null,
        headlessSource: typeof product.headlessSource === 'string' ? product.headlessSource : null,
        pageDevicePixelRatio: captured.pageDevicePixelRatio === null ? null : captured.pageDevicePixelRatio,
        deviceScaleFactor: captured.deviceScaleFactor,
        deviceScaleFactorSource: captured.deviceScaleFactorSource,
        viewport: { width: captured.viewport.width, height: captured.viewport.height },
        scroll: { x: captured.scroll.x, y: captured.scroll.y },
      };

      // 4) PNG structure + CRC. Bad bytes are never delivered.
      const png = inspectPng(data, { checkCrc: true });
      if (!png.ok) {
        throw new BrowserError('INVALID_PNG', '截图返回的字节不是结构完整的 PNG（不交付坏图）', {
          phase: 'inspectPng', reason: png.message, request: requestBlock, environment,
        });
      }

      // 5) Size check against the documented formula round(css × scale × dsf).
      const expected = expectedPixelSize({
        width: captured.region.width,
        height: captured.region.height,
        scale,
        deviceScaleFactor: captured.deviceScaleFactor,
      });
      const sizeCheck = checkPixelSize({ width: png.width, height: png.height }, expected);
      const baseCapture = {
        version: 1,
        format: 'png',
        transport: 'cdp-page-capture-screenshot',
        request: requestBlock,
        environment,
        png: { width: png.width, height: png.height, bytes: data.length, chunks: png.chunks, crc: 'ok' },
        expected: {
          width: expected.width,
          height: expected.height,
          pixelsPerCssPixel: expected.pixelsPerCssPixel,
        },
        // Canvas provenance (docs/viewport-control.md): C/S/O/content + explicit `composite`.
        // `composite:false` is the old single-CDP-PNG path (no re-encoding); `composite:true` means
        // the delivered PNG was composited on a white canvas and is therefore re-encoded.
        canvas: captured.canvas,
        composite: captured.composite,
        contentRect: captured.contentRect,
        pageCapture: captured.pageCapture,
        annotations: captured.annotations || null,
      };
      if (!sizeCheck.ok) {
        // Use the module's own verdict verbatim: CAPTURE_UPSCALED only says "larger than expected"
        // (a conservative refusal), it does not prove a bitmap was upscaled.
        const message = sizeCheck.code === 'CAPTURE_UPSCALED'
          ? `截图输出尺寸超过期望（实际 ${png.width}×${png.height}，期望 ${expected.width}×${expected.height}）：保守拒绝，不交付图片`
          : `截图输出尺寸与期望不符（实际 ${png.width}×${png.height}，期望 ${expected.width}×${expected.height}）：不交付图片`;
        throw new BrowserError(sizeCheck.code, message, {
          ...baseCapture,
          sizeCheck: {
            ok: false,
            actual: sizeCheck.details.actual,
            expected: sizeCheck.details.expected,
            tolerance: sizeCheck.details.tolerance,
            reason: sizeCheck.details.reason,
          },
        });
      }

      // 6) Canvas/document mapping (projected to pure JSON: no functions in a tool value).
      const mapping = projectCaptureMapping(createCaptureMapping({
        region: captured.region,
        scroll: captured.scroll,
        viewport: captured.viewport,
        scale,
        deviceScaleFactor: captured.deviceScaleFactor,
        coordinateSpace: captured.composite ? 'canvas-css-px' : 'document-css-px',
        canvas: captured.canvas,
        contentRect: captured.contentRect,
        blank: 'outside-content',
      }));
      // Per-axis mapping from the REAL PNG size (docs/viewport-control.md): the nominal
      // `pixelsPerCssPixel` stays for old consumers, these two fields are the actual sampling.
      // Coordinates: canvasX = region.x + imageX * region.width / png.width (canvas == document).
      mapping.cssPerPixel = {
        x: captured.region.width / png.width,
        y: captured.region.height / png.height,
      };
      mapping.scrollAtCapture = { x: captured.scroll.x, y: captured.scroll.y };
      mapping.formulas.continuous = captured.composite
        ? 'canvasX = region.x + imageX * region.width / imagePixels.width; '
          + 'viewportX = canvasX - scrollAtCapture.x'
        : 'docX = region.x + imageX * region.width / imagePixels.width; '
          + 'viewportX = docX - scrollAtCapture.x';

      // 7) Blank check: warns only. A pure-colour page is a legal page.
      let anomaly = {
        checked: false,
        uniform: null,
        transparent: null,
        sampledPixels: 0,
        distinctColors: null,
        averageColor: null,
        maxDelta: null,
        tolerance: 0,
      };
      const decoded = decodePng(data);
      const decodedPixels = decoded.ok ? decoded.width * decoded.height : 0;
      if (decoded.ok && decodedPixels <= CAPTURE_LIMITS.maxOutputPixels) {
        const detected = detectImageAnomaly(decoded, { tolerance: 0 });
        if (detected.ok) {
          anomaly = {
            checked: true,
            uniform: detected.uniform,
            transparent: detected.transparent,
            sampledPixels: detected.sampledPixels,
            distinctColors: detected.distinctColors,
            averageColor: { ...detected.averageColor },
            maxDelta: detected.maxDelta,
            tolerance: 0,
          };
          if (detected.uniform) addCaptureWarning(warnings, 'content_uniform');
          if (detected.transparent) addCaptureWarning(warnings, 'content_transparent');
        } else {
          addCaptureWarning(warnings, 'blank_check_skipped');
        }
      } else {
        addCaptureWarning(warnings, 'blank_check_skipped');
      }

      // 8) A region entirely outside the current page viewport is legal but worth flagging. For
      //    canvas-space captures the 16M/blank geometry is canvas, so compare the page-viewport
      //    projection (canvas - C) against the live scroll window instead of canvas vs scroll.
      if (request.region && captured.viewport.width > 0 && captured.viewport.height > 0) {
        const viewportRect = captured.composite
          ? {
            x: request.region.x - captured.canvas.x,
            y: request.region.y - captured.canvas.y,
            width: request.region.width,
            height: request.region.height,
          }
          : request.region;
        const vx = captured.scroll.x;
        const vy = captured.scroll.y;
        const outside = viewportRect.x + viewportRect.width <= vx
          || viewportRect.x >= vx + captured.viewport.width
          || viewportRect.y + viewportRect.height <= vy
          || viewportRect.y >= vy + captured.viewport.height;
        if (outside) addCaptureWarning(warnings, 'capture_beyond_viewport');
      }

      // 9) Atomic, no-clobber write of exactly the captured bytes.
      //    persistent -> workspace/env root (a write failure is a real error, never a silent pass).
      //    staging    -> the plugin instance's temporary root; a failure only drops the file, the
      //                  image is still delivered (existing warning vocabulary, no new code).
      let file = null;
      if (target) {
        const published = publishCapture(target.dir, target.absolutePath, data);
        if (!published.ok) {
          throw new BrowserError(published.code, published.message, { ...published.details, capture: baseCapture });
        }
        file = {
          path: target.relativePath,
          pathKind: 'relative',
          persistence: 'persistent',
          root: rootSource === 'env' ? 'env' : 'workspace',
          ephemeral: false,
          bytes: published.bytes,
          sha256,
          width: png.width,
          height: png.height,
          mode: published.mode,
          noClobber: true,
          createdAt: published.createdAt,
        };
      } else {
        try {
          const stagingRoot = ensureCaptureStagingRoot();
          const absolutePath = join(stagingRoot, exec.meta.actionId + '.png');
          const published = publishCapture(stagingRoot, absolutePath, data);
          if (!published.ok) throw new Error('staging publish failed: ' + published.code);
          file = {
            path: absolutePath,
            pathKind: 'absolute',
            persistence: 'staging',
            root: 'staging',
            ephemeral: true,
            bytes: published.bytes,
            sha256,
            width: png.width,
            height: png.height,
            mode: published.mode,
            noClobber: true,
            createdAt: published.createdAt,
          };
        } catch {
          // Staging is delivery evidence only: never fail the capture because tmp is unusable.
          addCaptureWarning(warnings, 'capture_file_unavailable');
        }
      }

      // 10) Attachment comparison: what the model receives vs the original capture.
      const delivery = {
        original: { width: png.width, height: png.height, bytes: data.length, sha256, mediaType: 'image/png' },
        image: null,
        downscaled: false,
        reencoded: false,
      };
      let attachment;
      let attachmentError;
      let imageDelivery = 'base64-fallback';
      if (typeof attachments?.saveImage === 'function') {
        try {
          attachment = projectAttachment(await abortable(
            attachments.saveImage({ data, mediaType: 'image/png', name: `ui-testing-${exec.meta.actionId}.png` }),
            exec.signal,
          ));
        } catch (error) {
          if (error.code === 'ABORTED') throw error;
          attachmentError = '附件保存失败，使用 base64-fallback';
        }
        if (attachment) {
          imageDelivery = 'attachment';
          const refWidth = Number.isFinite(attachment.width) ? attachment.width : null;
          const refHeight = Number.isFinite(attachment.height) ? attachment.height : null;
          const refBytes = Number.isFinite(attachment.bytes) ? attachment.bytes : null;
          const refMediaType = typeof attachment.mediaType === 'string' ? attachment.mediaType : null;
          delivery.image = { width: refWidth, height: refHeight, bytes: refBytes, mediaType: refMediaType };
          if ((refWidth !== null && refWidth < png.width) || (refHeight !== null && refHeight < png.height)) {
            delivery.downscaled = true;
            addCaptureWarning(warnings, 'model_image_downscaled');
          }
          // A normalized/re-encoded attachment no longer carries this capture's bytes: say so
          // instead of implying the model saw the file verbatim.
          if ((refMediaType !== null && refMediaType !== 'image/png')
            || (refBytes !== null && refBytes !== data.length)
            || (typeof attachment.sha256 === 'string' && attachment.sha256 !== sha256)) {
            delivery.reencoded = true;
            addCaptureWarning(warnings, 'attachment_reencoded');
          }
        }
      } else {
        addCaptureWarning(warnings, 'attachment_unavailable');
      }

      // 11) Lightweight facts for browser_capabilities.capture.observed (relative paths only).
      runtime.captureObservation = {
        observedAt: captured.capturedAt,
        scale,
        scaleSource,
        png: { width: png.width, height: png.height },
        sizeCheck: { ok: true },
        anomaly: { checked: anomaly.checked, uniform: anomaly.uniform, transparent: anomaly.transparent },
        delivery: { downscaled: delivery.downscaled },
        // No absolute path ever reaches capabilities: staging files are simply not addressable
        // from the observation, persistent ones keep their workspace-relative path.
        file: file
          ? { persistence: file.persistence, relativePath: file.pathKind === 'relative' ? file.path : null }
          : null,
      };

      const networkWindow = runtime.net
        ? runtime.net.window({ frameTimeMs: networkStart.frameTimeMs, captureEndMs: Date.now(), highWater: networkStart.highWater })
        : { sessionId: null, fromSeq: null, toSeq: null, frameTimeMs: networkStart.frameTimeMs, captureEndMs: Date.now(), nearest: null, count: 0 };
      // 12) Bound the inline fallback text: the attachment (when present) stays authoritative.
      const inline = inlineImageDelivery(shot.base64);
      if (inline.omitted) addCaptureWarning(warnings, 'image_base64_omitted');
      return {
        // Historical field kept verbatim: the CSS viewport actually captured (P7/P16 assert it).
        viewport: { width: captured.viewport.width, height: captured.viewport.height },
        // Top-level alias of `capture.networkWindow` (same object; additive only).
        networkWindow,
        bytes: data.length,
        image: inline.image,
        capturedAt: captured.capturedAt,
        sha256,
        attachment,
        attachmentId: attachment ? (attachment.attachmentId || attachment.id) : null,
        imageDelivery,
        ...(attachmentError === undefined ? {} : { attachmentError }),
        capture: {
          ...baseCapture,
          sizeCheck: {
            ok: true,
            actual: { width: png.width, height: png.height },
            expected: { width: expected.width, height: expected.height },
            upscaled: false,
          },
          mapping,
          anomaly,
          file,
          delivery,
          warnings,
          // Additive only: capture.version stays 1 and every existing field is untouched.
          image: { inline: inline.omitted ? 'omitted' : 'included', base64Bytes: inline.bytes, limitBytes: IMAGE_INLINE_BASE64_LIMIT },
          networkWindow,
        },
      };
    },
  });
  register({
    name: 'browser_input',
    description: '向内嵌浏览器派发鼠标 / 滚轮 / 键盘事件（T1 原生事件能力）。坐标使用页面 CSS 像素。'
      + '修饰键用 modifiers（字符串数组 alt/ctrl/meta/shift，或 CDP 位掩码整数 Alt=1/Ctrl=2/Meta=4/Shift=8）。'
      + '带按键状态机：keyDown 记位、keyUp 清位，按住 Shift 后其它事件自动带上 shiftKey（synthesizeModifiers:false 可关）；'
      + 'mouse 事件给 deltaX/deltaY 时按相对位移移动虚拟光标（无需知道绝对位置）；导航/关闭会清空状态。'
      + '返回 {ok,applied,modifiers,held,cursor}，held 是当前仍按住的键。',
    parameters: {
      type: 'object',
      properties: {
        events: {
          type: 'array',
          maxItems: 200,
          description: '单批上限 200 条；超出报 INVALID_ARGUMENT。逐条串行派发，超大数组只会长时间占用页面队列。',
          items: {
            type: 'object',
            properties: {
              kind: { type: 'string', enum: ['mouse', 'wheel', 'key', 'text'] },
              type: { type: 'string', description: 'mouse: mousePressed/mouseReleased/mouseMoved；key: keyDown/keyUp/rawKeyDown/char' },
              x: { type: 'number' },
              y: { type: 'number' },
              button: { type: 'string', description: '鼠标键：left/right/middle/back/forward/none' },
              buttons: { type: 'number', description: '按下的鼠标键位掩码（CDP buttons），移动/拖拽时需带上' },
              pointerType: { type: 'string', enum: ['mouse', 'pen'] },
              clickCount: { type: 'number' },
              deltaX: {
                type: 'number',
                description: 'mouse：相对位移 X（虚拟光标 += deltaX；用于 pointer-lock 类"按增量移动"）；wheel：滚动增量',
              },
              deltaY: {
                type: 'number',
                description: 'mouse：相对位移 Y（同上）；wheel：滚动增量',
              },
              synthesizeModifiers: {
                type: 'boolean',
                description: '默认 true：把当前按住的修饰键自动合进本事件的 modifiers（页面 e.shiftKey 等）。false 用于刻意复现"按住但没带修饰位"的行为',
              },
              modifiers: {
                description: '修饰键：字符串数组 alt/ctrl/meta/shift，或 CDP 位掩码整数（Alt=1,Ctrl=2,Meta=4,Shift=8）。key/mouse/wheel 都支持。',
                // Host-supported JSON-schema subset only (no minimum/maximum): the 0–15 range
                // is enforced at execution time in normalizeModifiers().
                oneOf: [
                  { type: 'array', items: { type: 'string', enum: ['alt', 'ctrl', 'meta', 'shift'] } },
                  { type: 'integer' },
                ],
              },
              key: { type: 'string', description: '键名或字符，如 a / Tab / Enter / Escape' },
              code: { type: 'string', description: '物理键位，如 KeyA / Tab / Enter' },
              text: { type: 'string', description: 'key: 随按键产生的文本（char 类型必需）；text kind: 直接插入的文本' },
              unmodifiedText: { type: 'string', description: '未受修饰键影响的文本（CDP unmodifiedText）' },
              virtualKeyCode: { type: 'number', description: 'CDP windowsVirtualKeyCode，决定页面 e.keyCode；如 Tab=9、Enter=13、Escape=27、A=65' },
              autoRepeat: { type: 'boolean', description: '是否为按键重复（页面 e.repeat）' },
              commands: { type: 'array', items: { type: 'string' }, description: 'CDP commands，如 ["selectAll"]（仅部分平台生效）' },
              location: { type: 'number', description: '键位：0 标准、1 左、2 右、3 数字键盘（页面 e.location）' },
              isKeypad: { type: 'boolean', description: '是否数字键盘按键' },
            },
            required: ['kind'],
          },
        },
      },
      required: ['events'],
    },
    output: { schema: { type: 'object' }, render: (args, value) => text(value) },
    async execute(args, exec) {
      // `held`/`modifiers` are the state machine's echo: a model that lost track of a keyDown can
      // see the leftover keys instead of guessing, and `cursor` is where relative moves now point.
      const result = await exec.runtime.input(args?.events, exec.signal);
      return { ok: true, ...result };
    },
  });
  register({
    // Read-only metadata read: it resolves the workspace scope but never takes the page queue or the
    // single-owner lease. The lease exists to serialise page *writes*; a traffic snapshot neither
    // writes the page nor needs ownership, and holding it for the lease TTL would block the next
    // page operation of another session in the same workspace.
    networkRead: true,
    name: 'browser_network',
    description: '读取内嵌浏览器最近捕获的网络请求（T1 网络抓包，默认不含请求体）。',
    parameters: {
      type: 'object',
      properties: { limit: { type: 'number', description: '最多返回条数，默认 50' } },
      required: [],
    },
    output: { schema: { type: 'object' }, render: (args, value) => text(value) },
    async execute(args, exec) {
      return exec.runtime.traffic(Number(args && args.limit) || 50);
    },
  });
  register({
    networkRead: true,
    name: 'browser_network_session',
    description: '启停/查询网络采集会话（WEB-P0）：start 是唯一的网络懒启动动作，stop 幂等，status/reset 只读不启动浏览器。'
      + 'config 支持 captureBodies/captureWebSocket/captureSse/captureWorkers/maxEvents(≤20000)/maxBodyBytes(≤1MiB)/maxTotalBytes(≤32MiB)/maxWsFrames(≤20000)/businessStatusPath/maskRules。',
    parameters: {
      type: 'object',
      additionalProperties: false,
      required: ['action'],
      properties: {
        action: { type: 'string', enum: ['start', 'stop', 'status', 'reset'], description: 'start|stop|status|reset' },
        name: { type: 'string', description: '会话名，≤64 字节，默认 default；同名 start 幂等' },
        config: { type: 'object', description: '仅 start 生效；未知字段与越界配额会被拒绝' },
      },
    },
    output: { schema: { type: 'object' }, render: (args, value) => text(value) },
    async execute(args, exec) {
      return p0(exec, 'B', String(args?.action || 'start'), args || {});
    },
  });
  register({
    networkRead: true,
    name: 'browser_network_events',
    description: '读取/筛选/检索/聚合网络事件（只读，不启动浏览器）：view=summary|full|timeline|aggregate，filter 支持 method/status/statusClass/resourceType/urlIncludes/failed/kind/phase/stepId/时间/耗时，search 命中只回脱敏预览。',
    parameters: {
      type: 'object',
      additionalProperties: false,
      required: [],
      properties: {
        sessionId: { type: 'string' },
        sinceSeq: { type: 'integer' },
        untilSeq: { type: 'integer' },
        cursor: { type: 'string' },
        limit: { type: 'integer', default: 50, description: '1–200，默认 50' },
        order: { type: 'string', enum: ['asc', 'desc'] },
        view: { type: 'string', enum: ['summary', 'full', 'timeline', 'aggregate'] },
        filter: { type: 'object' },
        search: { type: 'object' },
        groupBy: { type: 'string', enum: ['url', 'method', 'status', 'statusClass', 'resourceType', 'host', 'kind', 'step'] },
        aggregate: { type: 'array', items: { type: 'string' } },
      },
    },
    output: { schema: { type: 'object' }, render: (args, value) => text(value) },
    async execute(args, exec) {
      return p0(exec, 'B', 'events', args || {});
    },
  });
  register({
    networkRead: true,
    name: 'browser_network_detail',
    description: '按 requestId（同一 target 内）或 seq 读取一条请求/WS/SSE 的完整详情；纯只读，不启动 CDP、不补读 body。'
      + 'body 三态 captured|empty|unavailable，读不到即 available:false + NET_BODY_UNAVAILABLE，绝不伪造空体。',
    parameters: {
      type: 'object',
      additionalProperties: false,
      required: [],
      properties: {
        sessionId: { type: 'string' },
        requestId: { type: 'string' },
        seq: { type: 'integer' },
        hopId: { type: 'integer', description: '重定向跳数（内部键的一部分），跨 target 同 requestId 时配合 seq 使用' },
        targetId: { type: 'string' },
        include: { type: 'array', items: { type: 'string' } },
        maxBodyBytes: { type: 'integer', description: '1024–1048576，默认 1048576' },
      },
    },
    output: { schema: { type: 'object' }, render: (args, value) => text(value) },
    async execute(args, exec) {
      return p0(exec, 'B', 'detail', args || {});
    },
  });
  register({
    networkRead: true,
    name: 'browser_network_trace',
    description: '业务链路追踪：begin-step/end-step 开窗、mark 打标记、link 显式关联、window 查窗口、query 汇总（只读不启动浏览器）。'
      + '对象提取只按显式 objectRules；因果 basis 仅 explicit|redirect|initiator，temporal 需 includeTemporal:true 且不冒充因果。',
    parameters: {
      type: 'object',
      additionalProperties: false,
      required: ['action'],
      properties: {
        sessionId: { type: 'string' },
        action: { type: 'string', enum: ['begin-step', 'end-step', 'mark', 'link', 'window', 'query', 'reset'] },
        stepId: { type: 'string' },
        name: { type: 'string' },
        labels: { type: 'object' },
        window: { type: 'object' },
        objectRules: { type: 'array', items: { type: 'object' } },
        correlationRules: { type: 'array', items: { type: 'object' } },
        businessStatusPath: { type: 'string' },
        mark: { type: 'object' },
        link: { type: 'object' },
        query: { type: 'object' },
        includeTemporal: { type: 'boolean', default: false },
      },
    },
    output: { schema: { type: 'object' }, render: (args, value) => text(value) },
    async execute(args, exec) {
      return p0(exec, 'B', 'trace', args || {});
    },
  });
  register({
    networkRead: true,
    name: 'browser_network_control',
    description: '拦截/改写/限速/断连/重放/Mock（需要 page 的动作自行懒启动）：throttle/offline 组合状态下发、intercept-add/remove/clear/list、'
      + 'hold/resume、replay(via page|http)、mock、reset。reset 不停会话、不 Fetch.disable（导航守卫保持启用）。',
    parameters: {
      type: 'object',
      additionalProperties: false,
      required: ['action'],
      properties: {
        sessionId: { type: 'string' },
        action: {
          type: 'string',
          enum: ['throttle', 'offline', 'intercept-add', 'intercept-remove', 'intercept-clear', 'intercept-list', 'hold', 'resume', 'replay', 'mock', 'reset'],
        },
        throttle: { type: 'object' },
        offline: { type: 'boolean' },
        rule: { type: 'object' },
        ruleId: { type: 'string' },
        requestId: { type: 'string' },
        seq: { type: 'integer' },
        then: { type: 'object' },
        replay: { type: 'object' },
        mock: { type: 'object' },
        confirm: { type: 'boolean' },
      },
    },
    output: { schema: { type: 'object' }, render: (args, value) => text(value) },
    async execute(args, exec) {
      return p0(exec, 'B', 'control', args || {});
    },
  });
  register({
    networkRead: true,
    name: 'browser_network_evidence',
    description: '网络证据 JSONL/HAR 导入导出、索引、检索、链接与完整性（不启动浏览器）。'
      + 'export 只写持久根（env 或工作区 cwd）内的相对路径，只回相对路径；无持久根报 NET_OUTPUT_ROOT_UNKNOWN，绝不写暂存目录或回绝对路径。',
    parameters: {
      type: 'object',
      additionalProperties: false,
      required: ['action'],
      properties: {
        sessionId: { type: 'string' },
        action: { type: 'string', enum: ['export', 'import', 'index', 'search', 'link', 'integrity', 'clear', 'list'] },
        format: { type: 'string', enum: ['jsonl', 'har', 'auto'] },
        out: { type: 'string', description: '持久根内相对路径（.jsonl/.har）' },
        persist: { type: 'boolean' },
        includeBodies: { type: 'boolean' },
        file: { type: 'string', description: 'import：持久根内相对路径' },
        data: { type: 'string', description: 'import：内联文本 ≤8 MiB（与 file 二选一）' },
        query: { type: 'object' },
        link: { type: 'object' },
        deleteFiles: { type: 'boolean' },
      },
    },
    output: { schema: { type: 'object' }, render: (args, value) => text(value) },
    async execute(args, exec) {
      return p0(exec, 'B', 'evidence', args || {});
    },
  });
  register({
    networkRead: true,
    name: 'browser_network_subscribe',
    description: '同一 scope 内多 Agent 共享采集、各自独立订阅游标（owner-only）：create/poll/ack/close/list。'
      + 'ack 前不丢受 subscriptionPin 硬上限约束，超出给 gap/dropped；他人订阅 NET_SUBSCRIPTION_FORBIDDEN。',
    parameters: {
      type: 'object',
      additionalProperties: false,
      required: ['action'],
      properties: {
        sessionId: { type: 'string' },
        action: { type: 'string', enum: ['create', 'poll', 'ack', 'close', 'list'] },
        subscriptionId: { type: 'string' },
        cursor: { type: 'string' },
        afterSeq: { type: 'integer' },
        limit: { type: 'integer', description: '1–200' },
        kinds: { type: 'array', items: { type: 'string' } },
        ackSeq: { type: 'integer' },
      },
    },
    output: { schema: { type: 'object' }, render: (args, value) => text(value) },
    async execute(args, exec) {
      return p0(exec, 'B', 'subscribe', args || {});
    },
  });
  register({
    name: 'browser_dynamic_session',
    description: '启停/查询/重置本 scope 的 T4 动态会话（Web T4 M1）：start/stop/status/reset。'
      + 'captureVisual:true（默认）必须显式给 config.source=screencast|screenshot-loop；screencast 复用 T1 预览的唯一 CDP 流（jpeg，只挂 sink，不停/不重启预览，显式 png/region/非 1 scale 以 DYNAMIC_SOURCE_UNAVAILABLE 拒绝）。'
      + 'captureVisual:false 只建纯网络关联视图：networkSessionId 必给且须是已有本 scope P0 会话，不启动浏览器/P0、不采帧、motionSessionId=null。'
      + '同 scope 1 个活动会话；start 立即返回，采集由内部有界任务计时（durationMs 到界自动 stopped）。status/reset 只读缓存不启动浏览器。',
    hostOnly: (args, runtime) => {
      if (!args) return false;
      if (args.action === 'start') return Boolean(args.config && args.config.captureVisual === false);
      if (args.action === 'stop' || args.action === 'reset') {
        const state = runtime && runtime.dynamic;
        const sessions = state ? [state.session, ...state.records].filter(Boolean) : [];
        const hasObligation = sessions.some((session) => session.control && session.control.targets.length > 0);
        return !hasObligation;
      }
      return args.action === 'status' || args.action === 'extend';
    },
    parameters: {
      type: 'object',
      additionalProperties: false,
      required: ['action'],
      properties: {
        action: { type: 'string', enum: ['start', 'stop', 'status', 'reset', 'extend'] },
        name: { type: 'string', description: '≤64 字节，仅 start，默认 default' },
        config: {
          type: 'object',
          description: '仅 start：captureVisual/networkSessionId/source/encoding/durationMs/maxFrames/maxBytes/region/scale/sampleIntervalMs',
        },
      },
    },
    output: { schema: { type: 'object' }, render: (args, value) => text(value) },
    async execute(args, exec) {
      try {
        return await exec.runtime.dynamicSession(args || {}, exec, exec.signal);
      } catch (error) {
        const classified = asBrowserError(error);
        const operation = 'session.' + String((args && args.action) || 'unknown');
        classified.details = { ...(classified.details || {}), evidence: { dynamic: exec.runtime.dynamicErrorEvidence(operation) } };
        throw classified;
      }
    },
  });
  register({
    readOnly: (args) => !args || args.fresh !== true,
    name: 'browser_motion_observe',
    description: '只读查询 T4 动态会话的帧元数据与事件（不 ensure、不续租、不启动浏览器）：motionSessionId 必填，支持 cursor/sinceSeq/window/frameIds/limit；'
      + '顶层 sampling 给出实测采样机制/节奏/间隔统计（measured 优先于 requested）；'
      + 'fresh=true 是显式页面动作，只允许当前活动视觉会话，返回一次该会话采样规格的真实采样区间（beginMonoMs/endMonoMs）。'
      + 'includeImages=true 最多命中 3 帧，附原图 hash/尺寸与 inline base64 交付事实，不自动落盘、不生成 T3 product。',
    parameters: {
      type: 'object',
      additionalProperties: false,
      required: ['motionSessionId'],
      properties: {
        motionSessionId: { type: 'string' },
        fresh: { type: 'boolean', default: false },
        sinceSeq: { type: 'integer' },
        cursor: { type: 'string' },
        limit: { type: 'integer', default: 50, description: '1–200' },
        window: {
          type: 'object',
          properties: { fromMs: { type: 'number' }, toMs: { type: 'number' } },
          required: ['fromMs', 'toMs'],
        },
        frameIds: { type: 'array', items: { type: 'string' } },
        includeImages: { type: 'boolean', default: false },
        region: {
          type: 'object',
          description: '帧图像像素矩形（image-px），只交付该矩形；仅与 includeImages:true 同用（单独给 region 抛 DYNAMIC_INVALID_ARGUMENT）',
          additionalProperties: false,
          properties: {
            x: { type: 'integer', minimum: 0 },
            y: { type: 'integer', minimum: 0 },
            width: { type: 'integer', minimum: 1 },
            height: { type: 'integer', minimum: 1 },
          },
          required: ['x', 'y', 'width', 'height'],
        },
      },
    },
    output: { schema: { type: 'object' }, render: (args, value) => text(value) },
    async execute(args, exec) {
      try {
        return await exec.runtime.dynamicObserve(args || {}, exec, exec.signal);
      } catch (error) {
        const classified = asBrowserError(error);
        classified.details = { ...(classified.details || {}), evidence: { dynamic: exec.runtime.dynamicErrorEvidence('motion.observe') } };
        throw classified;
      }
    },
  });
  register({
    readOnly: true,
    name: 'browser_motion_analyze',
    description: '离线分析已存 T4 帧（不采新帧、不 ensure、不续租）：motionSessionId + 1–20 条断言，window/frameIds 恰好一个。'
      + '七类断言 frame-diff/region-change/flicker/freeze/jank/trajectory/transition 由纯核心 dynamic-t4.js 执行；'
      + '返回 results/summary/verdict/exitCode（FAIL>BLOCKED>INCONCLUSIVE>WARN>PASS）与 integrity，缺证据为 INCONCLUSIVE/BLOCKED 而非 PASS。',
    parameters: {
      type: 'object',
      additionalProperties: false,
      required: ['motionSessionId', 'assertions'],
      properties: {
        motionSessionId: { type: 'string' },
        window: {
          type: 'object',
          properties: { fromMs: { type: 'number' }, toMs: { type: 'number' } },
          required: ['fromMs', 'toMs'],
        },
        frameIds: { type: 'array', items: { type: 'string' } },
        assertions: { type: 'array', items: { type: 'object' } },
      },
    },
    output: { schema: { type: 'object' }, render: (args, value) => text(value) },
    async execute(args, exec) {
      try {
        return await exec.runtime.dynamicAnalyze(args || {}, exec);
      } catch (error) {
        const classified = asBrowserError(error);
        classified.details = { ...(classified.details || {}), evidence: { dynamic: exec.runtime.dynamicErrorEvidence('motion.analyze') } };
        throw classified;
      }
    },
  });
  register({
    name: 'browser_motion_control',
    description: '对已声明适配器目标做真实时间轴控制（M2，WAAPI adapterId="waapi"）：pause/resume/seek/rate/restore。'
      + '非 restore 必给 adapterId/targetIds(1–20)；seek 只给 timeMs、rate 只给 rate；整批预检通过才派发，逐目标 before/after 回读，'
      + '失败/部分应用返回 applied/failedIndex/restoreStatus 并尽力恢复；restore 用本会话 restoreToken 恢复原状态，外部已改则 conflict 不覆盖。'
      + '不提供“冻结整个浏览器”承诺，像素证据仍走 browser_motion_observe。',
    parameters: {
      type: 'object',
      additionalProperties: false,
      required: ['motionSessionId', 'action'],
      properties: {
        motionSessionId: { type: 'string' },
        action: { type: 'string', enum: ['pause', 'resume', 'seek', 'rate', 'restore'] },
        adapterId: { type: 'string' },
        targetIds: { type: 'array', items: { type: 'string' } },
        timeMs: { type: 'number' },
        rate: { type: 'number' },
        restoreToken: { type: 'string' },
      },
    },
    output: { schema: { type: 'object' }, render: (args, value) => text(value) },
    async execute(args, exec) {
      try {
        return await exec.runtime.dynamicControl(args || {}, exec, exec.signal);
      } catch (error) {
        const classified = asBrowserError(error);
        classified.details = { ...(classified.details || {}), evidence: { dynamic: exec.runtime.dynamicErrorEvidence('motion.control') } };
        throw classified;
      }
    },
  });
  register({
    readOnly: true,
    name: 'browser_dynamic_correlate',
    description: 'T4 动态事件关联查询（M3，只读不启动浏览器）：dynamicSessionId + motionSessionId/networkSessionId（首次至少一个，须属于该动态会话）。'
      + '六向 directions、basis/grade、includeTemporal 默认 false（只回时间邻近不混入因果）、beforeMs/afterMs 默认 250/1000、limit/cursor。'
      + '网络侧复用 P0 已采集事件/RequestKey，不新建第二套抓包；无共同 ID 或协议父端点只进 observed/temporal/unresolved，查询固定 verdict=INCONCLUSIVE(no-assertion)。',
    parameters: {
      type: 'object',
      additionalProperties: false,
      required: ['dynamicSessionId'],
      properties: {
        dynamicSessionId: { type: 'string' },
        motionSessionId: { type: 'string' },
        networkSessionId: { type: 'string' },
        window: {
          type: 'object',
          properties: { fromMs: { type: 'number' }, toMs: { type: 'number' } },
          required: ['fromMs', 'toMs'],
        },
        directions: { type: 'array', items: { type: 'string', enum: [...DYNAMIC_DIRECTIONS] } },
        eventIds: { type: 'array', items: { type: 'string' } },
        includeTemporal: { type: 'boolean', default: false },
        beforeMs: { type: 'number' },
        afterMs: { type: 'number' },
        limit: { type: 'integer' },
        cursor: { type: 'string' },
      },
    },
    output: { schema: { type: 'object' }, render: (args, value) => text(value) },
    async execute(args, exec) {
      try {
        return await exec.runtime.dynamicCorrelate(args || {}, exec);
      } catch (error) {
        const classified = asBrowserError(error);
        classified.details = { ...(classified.details || {}), evidence: { dynamic: exec.runtime.dynamicErrorEvidence('dynamic.correlate') } };
        throw classified;
      }
    },
  });
  register({
    name: 'browser_computed_style',
    description: '读取内嵌浏览器里某个元素的计算样式（T1 CSSOM 能力）。',
    parameters: {
      type: 'object',
      properties: {
        selector: { type: 'string' },
        properties: { type: 'array', items: { type: 'string' } },
      },
      required: ['selector'],
    },
    output: { schema: { type: 'object' }, render: (args, value) => text(value) },
    // Defense in depth: the registered schema already requires `selector`, but a caller that
    // bypasses schema validation (programmatic dispatch, an older client) must get a classified
    // argument error instead of a confusing "element not found: undefined" page miss.
    preflight: (args) => {
      const selector = args && typeof args.selector === 'string' ? args.selector.trim() : '';
      if (selector === '') {
        throw new BrowserError('INVALID_ARGUMENT', 'selector 不能为空', { field: 'selector' });
      }
    },
    async execute(args, exec) {
      return exec.runtime.computedStyle(String(args && args.selector), Array.isArray(args && args.properties) ? args.properties : undefined, exec.signal);
    },
  });
  register({
    name: 'browser_http_request',
    description: '用独立的 HTTP(S) 客户端直接请求接口（不启动 Chromium、不占用页面租约、无 Cookie jar）：'
      + 'ok:true 只表示取得响应，不代表 2xx；默认 GET/5s/64KiB、默认不跟随重定向；响应体按字节上限截断并标记 truncated。',
    parameters: {
      type: 'object',
      additionalProperties: false,
      required: ['url'],
      properties: {
        method: {
          type: 'string',
          enum: ['GET', 'HEAD', 'POST', 'PUT', 'PATCH', 'DELETE', 'OPTIONS'],
          default: 'GET',
          description: 'HTTP 方法，大小写严格匹配；默认 GET',
        },
        url: { type: 'string', description: '绝对 HTTP(S) URL；不 trim；UTF-8 ≤ 8192 字节（执行时校验）' },
        headers: { type: 'object', description: '调用方请求头：单值字符串；≤64 条、键 ≤128 字符、单值 ≤4096 字节、合计 ≤8192 字节、重名与危险头在执行时校验' },
        body: { type: 'string', description: 'UTF-8 请求体，≤65536 字节（执行时校验）；GET/HEAD 提供即拒绝；不自动设置 content-type' },
        timeoutMs: { type: 'integer', default: 5000, description: '总截止时间毫秒（覆盖 DNS/连接/每跳/头/正文）；范围 1–20000（执行时校验）' },
        maxBytes: { type: 'integer', default: 65536, description: '响应保留字节上限；范围 1–1048576（执行时校验）' },
        followRedirects: { type: 'boolean', default: false, description: '是否手动跟随重定向；默认不跟随' },
        maxRedirects: { type: 'integer', default: 0, description: '最多再派发跳数；范围 0–5（执行时校验）；followRedirects=false 时不生效' },
      },
    },
    output: { schema: { type: 'object' }, render: (args, value) => text(value) },
    async execute(args, exec) {
      // FR-01/INF-08: an active scope session on this workspace also governs the independent HTTP
      // client (origin allowlist, path prefix, budget and the destructive-operation gate). With no
      // scope configured the call is unchanged (FR-12: security is opt-in).
      const runtime = exec.runtime ?? null;
      const method = String(args?.method || 'GET').toUpperCase();
      if (runtime && typeof runtime.scopeGuardHttp === 'function') {
        runtime.scopeGuardHttp({ url: String(args?.url || ''), method, actionId: exec.meta?.actionId ?? null });
      }
      try {
        return await httpClient.request(args, { signal: exec.signal, meta: exec.meta });
      } finally {
        runtime?.scopeCompleteHttpDispatch?.();
      }
    },
  });
  register({
    name: 'browser_snapshot',
    description: '读取页面的结构化快照（无障碍树 + 可交互元素 ref）：先 snapshot 拿 ref=e1/e2…，再用 click/type/scroll/fill_form/node_state/wait_for 操作。'
      + 'ref 编号在本次运行内单调增长、永不复用；主框架跨文档导航/刷新/历史前进后退、主执行上下文丢失与关闭会使 ref 失效（REF_STALE）。',
    parameters: {
      type: 'object',
      properties: {
        scope: {
          type: 'object',
          description: '只在某个 ref 或唯一 selector 的子树内建快照（默认整个主文档）；两者恰给一个',
          properties: {
            ref: { type: 'string', description: '快照里的 ref（eN）' },
            selector: { type: 'string', description: '主文档内唯一命中的 CSS 选择器' },
          },
          required: [],
        },
        maxNodes: { type: 'integer', description: `最多输出的语义节点数，默认 ${T2_LIMITS.snapshotDefaultMaxNodes}，上限 ${T2_LIMITS.snapshotMaxNodes}` },
        depth: { type: 'integer', description: `最大深度，默认 ${T2_LIMITS.snapshotDefaultDepth}；0 表示只输出根节点，上限 ${T2_LIMITS.snapshotMaxDepth}` },
        boxes: { type: 'boolean', description: '是否在行尾追加 [box=x,y,width,height] 并回填 refs.bbox（默认 false）' },
      },
      required: [],
    },
    output: { schema: { type: 'object' }, render: (args, value) => text(value) },
    async execute(args, exec) {
      return exec.runtime.snapshot(args || {}, exec.signal);
    },
  });
  register({
    name: 'browser_click',
    description: '点击快照里的元素（ref 或唯一 selector）：滚动进视口、两次动画帧确认稳定、命中校验通过后用 CDP 真实鼠标事件派发（不是页面内 .click()）。'
      + 'hidden/disabled/inert/零面积/离屏/被遮挡/持续运动都零派发失败（NOT_INTERACTABLE，details.reason 说明原因；hidden/covered 带 escalation:T3）。',
    parameters: {
      type: 'object',
      properties: {
        ref: { type: 'string', description: '快照里的 ref（eN）' },
        selector: { type: 'string', description: '主文档内唯一命中的 CSS 选择器' },
        button: { type: 'string', description: '鼠标键：left/right/middle，默认 left' },
        clickCount: { type: 'integer', description: '1 或 2（2 = 双击：两组 press/release，clickCount 依次 1、2），默认 1' },
        modifiers: { type: 'array', items: { type: 'string' }, description: '修饰键 alt/ctrl/meta/shift（不重复，最多 4 项）' },
      },
      required: [],
    },
    output: { schema: { type: 'object' }, render: (args, value) => text(value) },
    async execute(args, exec) {
      return exec.runtime.click(args || {}, exec.signal);
    },
  });
  register({
    name: 'browser_type',
    description: '向快照里的原生输入框输入文本：可信点击定位焦点并用深层 activeElement 校验，replace:true（默认）先 Ctrl+A + Backspace 再 Input.insertText，replace:false 追加到末尾；'
      + 'submit:true 在值校验通过后派发 Enter。仅支持 input text/search/email/url/tel/password 与 textarea，其它控件抛 UNSUPPORTED。结果不回显输入原文。',
    parameters: {
      type: 'object',
      properties: {
        ref: { type: 'string', description: '快照里的 ref（eN）' },
        selector: { type: 'string', description: '主文档内唯一命中的 CSS 选择器' },
        text: { type: 'string', description: '要输入的文本（允许空串 = 清空，≤65536 UTF-8 字节）' },
        replace: { type: 'boolean', description: '是否替换已有内容，默认 true' },
        submit: { type: 'boolean', description: '输入后派发 Enter，默认 false' },
      },
      required: ['text'],
    },
    output: { schema: { type: 'object' }, render: (args, value) => text(value) },
    async execute(args, exec) {
      return exec.runtime.typeText(args || {}, exec.signal);
    },
  });
  register({
    name: 'browser_scroll',
    description: '滚动：默认操作 document.scrollingElement，给 ref/selector 时滚动该元素自身的滚动区。direction 与 to 必给且只给一个：'
      + 'direction 派发 CDP mouseWheel 后最多观察 1000ms 至坐标稳定；to=top|bottom 用 scrollTo 精确定位（eventSource=dom-scroll，不接受 amount）。到边界 moved=false 仍是成功。',
    parameters: {
      type: 'object',
      properties: {
        ref: { type: 'string', description: '滚动容器（快照 ref）；省略则滚动文档' },
        selector: { type: 'string', description: '滚动容器（唯一 CSS 选择器）' },
        direction: { type: 'string', description: 'up/down/left/right（与 to 二选一）' },
        amount: { type: 'integer', description: `滚动量（CSS 像素），默认 ${T2_LIMITS.scrollAmount}，1–${T2_LIMITS.scrollMaxAmount}` },
        to: { type: 'string', description: 'top/bottom：精确滚到端点；与 direction 二选一，且不接受 amount' },
      },
      required: [],
    },
    output: { schema: { type: 'object' }, render: (args, value) => text(value) },
    async execute(args, exec) {
      return exec.runtime.scroll(args || {}, exec.signal);
    },
  });
  register({
    name: 'browser_fill_form',
    description: '按顺序填写多个原生控件（textbox/checkbox/radio/combobox/slider）：整批先校验参数、解析全部目标、检查控件类型/选项/取值范围与重复目标，全部通过才逐项执行。'
      + 'textbox/checkbox/radio 用可信 CDP 输入；combobox/slider 用原生 setter（eventSource=dom-control，不打开原生下拉、不模拟拖动）。'
      + '失败停止不回滚：details 带 applied/failedIndex/fields。',
    parameters: {
      type: 'object',
      properties: {
        fields: {
          type: 'array',
          items: {
            type: 'object',
            properties: {
              ref: { type: 'string', description: '快照里的 ref（eN）' },
              selector: { type: 'string', description: '主文档内唯一命中的 CSS 选择器' },
              type: { type: 'string', description: 'textbox/checkbox/radio/combobox/slider' },
              value: { description: 'textbox: 字符串；checkbox/radio: 布尔（radio 只接受 true）；combobox: 字符串或字符串数组；slider: 有限数字' },
            },
            required: ['type', 'value'],
          },
        },
      },
      required: ['fields'],
    },
    output: { schema: { type: 'object' }, render: (args, value) => text(value) },
    async execute(args, exec) {
      return exec.runtime.fillForm(args || {}, exec.signal);
    },
  });
  register({
    name: 'browser_node_state',
    description: '读取单个节点的完整当前状态（ref 或唯一 selector）：role/name/可见/启用/只读/勾选/展开/焦点/bbox/hitTarget/滚动等，现场读取而不复用快照。'
      + 'hidden/disabled/readonly/被遮挡的节点也能成功读取；可编辑控件的 value 默认脱敏为 null（valueRedacted:true）。',
    parameters: {
      type: 'object',
      properties: {
        ref: { type: 'string', description: '快照里的 ref（eN）' },
        selector: { type: 'string', description: '主文档内唯一命中的 CSS 选择器' },
      },
      required: [],
    },
    output: { schema: { type: 'object' }, render: (args, value) => text(value) },
    async execute(args, exec) {
      return exec.runtime.nodeState(args || {}, exec.signal);
    },
  });
  register({
    name: 'browser_wait_for',
    description: '在同一个页面队列内轮询等待：text/textGone（主文档 body.innerText 包含/不包含）或 ref/selector + state{visible,enabled,checked,valueEquals}（AND，省略 state 等价 visible:true）。三类条件互斥。'
      + '超时抛 WAIT_TIMEOUT（details 含 elapsedMs/polls/condition/最后观察），页面不关闭；ref 失效立即 REF_STALE。',
    parameters: {
      type: 'object',
      properties: {
        text: { type: 'string', description: '等待正文包含该子串（≤4096 字节）' },
        textGone: { type: 'string', description: '等待正文不再包含该子串（≤4096 字节）' },
        ref: { type: 'string', description: '等待目标（快照 ref）' },
        selector: { type: 'string', description: '等待目标（唯一 CSS 选择器；0 命中时 visible:false 可满足）' },
        state: {
          type: 'object',
          description: '目标状态条件（需同时给 ref 或 selector）',
          properties: {
            visible: { type: 'boolean' },
            enabled: { type: 'boolean' },
            checked: { type: 'boolean' },
            valueEquals: { type: 'string' },
          },
          required: [],
        },
        timeoutMs: { type: 'integer', description: `超时预算毫秒，默认 ${T2_LIMITS.waitDefaultTimeoutMs}，0 表示只采样一次，上限 ${T2_LIMITS.waitMaxTimeoutMs}` },
        pollMs: { type: 'integer', description: `轮询间隔毫秒，默认 ${T2_LIMITS.waitDefaultPollMs}（${T2_LIMITS.waitMinPollMs}–${T2_LIMITS.waitMaxPollMs}）` },
      },
      required: [],
    },
    // A 30000ms condition budget must be able to report WAIT_TIMEOUT before the host kills the
    // call, so this tool alone gets a larger envelope timeout (contract §4.4).
    timeoutMs: 35000,
    output: { schema: { type: 'object' }, render: (args, value) => text(value) },
    async execute(args, exec) {
      return exec.runtime.waitFor(args || {}, exec.signal);
    },
  });
  register({
    name: 'browser_tabs',
    description: 'P0-E 多标签页的 Web 实现：list/current 只读诊断；wait 纯内存等待调用开始后新出现的标签（0–30000ms，不启动 Chromium、不取 lease），命中返回 matched/matchedTab/elapsedMs/polls，超时抛 WAIT_TIMEOUT；'
      + 'select 选择当前 Agent 会话的 tab（不启动页面）；open 新建 about:blank 并选中；close 按页面访问权限关闭标签（primary 只变 cold）。'
      + 'list 每项含 source/parentTabId/openEventId/createdAt/lastUsedAt/idleRemainingMs/locked/manageable，并返回本 workspace 最近 8 条 blocked popup notices 与最近 8 条 recentClosed（reason closed|idle|evicted）。'
      + 'locked 是面板人力保活锁（只读投影）：锁定为 true 时该标签不被 idle/LRU 回收，此时 idleRemainingMs 为 null；该锁没有 Agent 工具，只有面板能开关。'
      + 'select 的 mode=work（默认）设置写目标、observe 设置只读观察目标；select 不再 claim 15 秒写租约，被拒绝的 select 不改变调用者已有选择。'
      + '页面按 (workspace, provider, root) 分组：跨会话/跨 root 的标签根本不在同一组，因此 tabId 只会解析到本 root 的页。'
      + '每行新增 accessVersion/rootSessionId/ownerSessionId/controllerSessionId/ownershipRevision/controlRevision/accessState/permissions；busy/owner/manageable 仍表示原短租约含义（不作为 ACL）。',
    parameters: {
      type: 'object',
      properties: {
        action: {
          type: 'string',
          enum: ['list', 'current', 'select', 'open', 'close', 'wait', 'acquire', 'release', 'transfer'],
          description: 'acquire/release/transfer 为队长控制权动作（仅本 root Lead）：acquire 进入 draining 等安全边界后接管，release 归还 owner，transfer 转交本 root 有效成员。',
        },
        toSessionId: { type: 'string', minLength: 1, maxLength: 128, description: '仅 transfer：本 root 内有效 roster 成员 SessionId（提交前重取原生 roster 校验）。' },
        expectedControlRevision: { type: 'integer', minimum: 1, maximum: 9007199254740991, description: '仅 acquire/release/transfer：CAS 期望的 controlRevision，不匹配返回 TAB_CONTROL_CHANGED。' },
        expectedOwnershipRevision: { type: 'integer', minimum: 1, maximum: 9007199254740991, description: '仅 transfer：CAS 期望的 ownershipRevision，不匹配返回 TAB_OWNERSHIP_STALE。' },
        mode: { type: 'string', enum: ['work', 'observe'], description: '仅 select：work（默认）=该页成为本会话写目标，需本会话可写或本 root Lead 可管理；observe=只读观察目标，只改 observationSelection，不 claim、不 activate。' },
        tabId: { type: 'string', description: '目标 tabId（1–128 字符）；select/close 使用；wait 用它是等待该 tabId 出现（已存在则立即命中），其余 action 忽略。' },
        kind: { type: 'string', enum: ['primary', 'tab'], description: '仅 wait：只匹配该 kind（list 中 primary/tab）。' },
        source: { type: 'string', enum: ['primary', 'gui-popup', 'agent-open'], description: '仅 wait：只匹配该来源（primary 槽 / GUI 真人 popup 或 GUI + / Agent open）。' },
        timeoutMs: { type: 'integer', minimum: 0, maximum: 30000, description: '仅 wait/acquire：wait 是等待预算（默认 5000，0 只采样一次，超时 WAIT_TIMEOUT）；acquire 是等待安全边界的预算（默认 5000，超时返回 BUSY 并撤销 draining）。' },
        pollMs: { type: 'integer', minimum: 50, maximum: 1000, description: '仅 wait：轮询间隔，默认 100。' },
      },
      required: ['action'],
      additionalProperties: false,
    },
    // A 30000ms wait budget must be able to report WAIT_TIMEOUT before the host kills the call.
    timeoutMs: 35000,
    output: { schema: { type: 'object' }, render: (args, value) => text(value) },
    async execute(args, exec) {
      return crossEnvironment.invokeTabs(args, exec);
    },
  });
  register({
    name: 'browser_viewport',
    // `get` is a cache diagnostic only: the wrapper must not ensure/queue/lease/activate for it.
    readOnly: (args) => Boolean(args) && typeof args === 'object' && args.action === 'get',
    // Pure pre-flight outside the queue: a rejected patch costs no CDP and no page change.
    preflight: (args) => { normalizeViewportRequest(args); },
    description: '共享视口（T1）：get=只读缓存诊断（不启动浏览器、不发 CDP、不占租约；可读取他人租约下的缓存，stale 明示）；'
      + 'set=页面操作（懒启动 + 串行队列 + single-owner-lease，仅改比例也算页面操作）。坐标是文档 CSS 像素的页面顶层滚动位置（x/y），'
      + '不是窗口位置；画布坐标 canvasX/canvasY 是视口左上角在文档画布上的位置（可为负/越出内容），与 x/y 不能同 patch 混用。'
      + '宽高显式修改页面 CSS 视口，仅改比例不改视口/DPR/页面缩放。'
      + 'mode 预设 wide/landscape/tablet/phone；expectedRevision 冲突返回 VIEWPORT_CONFLICT（本次 patch 零应用）。',
    parameters: {
      type: 'object',
      additionalProperties: false,
      required: ['action'],
      properties: {
        action: { type: 'string', enum: ['get', 'set'], description: 'get=只读缓存诊断（不接受其他字段）；set=应用一个 patch（至少一个 view 字段）' },
        mode: {
          type: 'string',
          enum: ['wide', 'landscape', 'tablet', 'phone'],
          description: '预设：wide 1920×1080 / landscape 1024×768 / tablet 768×1024 / phone 393×852；与 width/height 互斥。custom 只作为派生返回值。',
        },
        x: { type: 'number', description: `页面顶层滚动位置 X（文档 CSS px，${VIEW_LIMITS.scroll[0]}–${VIEW_LIMITS.scroll[1]}）；成功后回读实际值（可能被 clamp）` },
        y: { type: 'number', description: `页面顶层滚动位置 Y（文档 CSS px，${VIEW_LIMITS.scroll[0]}–${VIEW_LIMITS.scroll[1]}）；成功后回读实际值（可能被 clamp）` },
        canvasX: { type: 'number', description: `画布坐标 X：视口左上角在文档画布上的位置（CSS px，${VIEW_LIMITS.canvas[0]}–${VIEW_LIMITS.canvas[1]}，可为负）；与 x/y 不能同 patch。O = canvasX - x 由 Host 派生。` },
        canvasY: { type: 'number', description: `画布坐标 Y：视口左上角在文档画布上的位置（CSS px，${VIEW_LIMITS.canvas[0]}–${VIEW_LIMITS.canvas[1]}，可为负）；与 x/y 不能同 patch。` },
        width: { type: 'integer', description: `CSS 视口宽（整数 ${VIEW_LIMITS.width[0]}–${VIEW_LIMITS.width[1]}）；只有宽高变化才发送 Emulation.setDeviceMetricsOverride` },
        height: { type: 'integer', description: `CSS 视口高（整数 ${VIEW_LIMITS.height[0]}–${VIEW_LIMITS.height[1]}）` },
        scale: {
          type: 'number',
          description: `共享显示比例 ${VIEW_LIMITS.scale[0]}–${VIEW_LIMITS.scale[1]}（即 ${VIEW_LIMITS.scale[0] * 100}–${VIEW_LIMITS.scale[1] * 100}%，1=100%）；`
            + '也是省略 scale 的 browser_screenshot 默认比例。不是 DPR、不是页面缩放、不做设备模拟（dsf 固定 1）。',
        },
        expectedRevision: { type: 'integer', description: '可选 CAS：与队列内当前 view.revision 不同则 VIEWPORT_CONFLICT（不应用 patch，返回 latest view）' },
      },
    },
    output: { schema: { type: 'object' }, render: (args, value) => text(value) },
    async execute(args, exec) {
      const request = normalizeViewportRequest(args);
      if (request.action === 'get') {
        // Cache-only: the wrapper already bypasses run()/ensure()/lease for this action.
        return exec.runtime.viewSnapshot();
      }
      const result = await exec.runtime.applyView(expandViewPatch(request.patch), {
        signal: exec.signal,
        source: 'agent',
        originId: null,
        expectedRevision: request.expectedRevision,
      });
      return { ok: true, ...result, requested: { ...request.requested } };
    },
  });
  register({
    name: 'browser_annotation',
    // Reading is a cached host read; every mutating action only rewrites the Host-side document.
    // Neither branch may ensure a page, take the page queue/lease, activate the tab or touch
    // `lastError`: a drawn note must cost the page nothing (docs/viewport-control.md).
    readOnly: (args) => Boolean(args) && typeof args === 'object' && args.action === 'read',
    hostOnly: (args) => Boolean(args) && typeof args === 'object' && args.action !== 'read',
    // Pure pre-flight outside the queue: a refused call costs zero state and zero CDP.
    preflight: (args) => { normalizeAgentAnnotationCall(args); },
    description: 'P0 标注（人类可见）：读写调试视图里同一份标注文档，人类在面板里能立刻看到。'
      + 'action=read 返回图形列表与 revision（不写、不需要前台）；'
      + 'draw 追加图形（circle/rect/line/arrow/brush/text，对应面板的圆形/矩形/线段/箭头/画笔/文字）；'
      + 'erase 按 id 或按点命中删除（对应橡皮擦）；clear 清空画布。'
      + '每个图形可带 color（#rrggbb，默认 #ff3b30）、strokeWidth（1–20，默认 3）与 style=stroke|fill（对应外框/填充，仅圆形/矩形；'
      + '也可显式 fill/stroke 布尔值，二者不可同时给）。'
      + '坐标是画布 CSS px：q=d-C、O=C-S、页面视口 p=q+O=d-S；与 browser_screenshot{includeAnnotations:true} 同一空间。'
      + 'draw/erase/clear 只在目标标签页正被人类在调试视图选中并可见时才允许，否则 ANNOTATION_NOT_FOREGROUND 零写入；'
      + 'expectRevision 不一致返回 ANNOTATION_REVISION_CONFLICT。'
      + '只写 Host 文档：不启动浏览器、不进页面队列、不占租约、不改页面 DOM 与 lastError；软限额与面板写面相同（128 图形/8192 点/65536 字节，Host 确定性裁剪并如实报 truncated）。',
    parameters: {
      type: 'object',
      additionalProperties: false,
      required: ['action'],
      properties: {
        action: {
          type: 'string',
          enum: [...ANNOTATION_AGENT_ACTIONS],
          description: 'read=读当前文档；draw=追加图形；erase=删除图形；clear=清空画布（后三者需要人类前台标签页）',
        },
        shapes: {
          type: 'array',
          minItems: 1,
          maxItems: ANNOTATION_AGENT_MAX_SHAPES_PER_CALL,
          description: 'draw 专用：要追加的图形（1–64 个）。省略 id 时 Host 从现有最大 id 续分配 a<N>；id 一旦重复或格式不符即整批拒绝。',
          items: {
            type: 'object',
            additionalProperties: false,
            required: ['type'],
            properties: {
              type: {
                type: 'string',
                enum: [...ANNOTATION_TYPES],
                description: 'circle=圆形 / rect=矩形 / line=线段 / arrow=箭头 / brush=画笔（铅笔）/ text=文字（写问题、问号、说明）',
              },
              id: { type: 'string', description: '可选，形如 a12（^a[1-9][0-9]{0,15}$）；省略时由 Host 分配' },
              color: { type: 'string', description: '可选，#rrggbb，默认 #ff3b30（面板默认色）' },
              strokeWidth: {
                type: 'integer',
                description: `可选，粗细 ${ANNOTATION_LIMITS.strokeWidth[0]}–${ANNOTATION_LIMITS.strokeWidth[1]}，默认 ${ANNOTATION_AGENT_DEFAULT_STROKE}；箭头头部按端点+线宽派生`,
              },
              style: {
                type: 'string',
                enum: ['stroke', 'fill'],
                description: '可选：stroke=外框（默认）/ fill=填充；只对 circle/rect 有意义（text 固定填充，line/arrow/brush 固定外框）。与 fill/stroke 互斥。',
              },
              fill: { type: 'boolean', description: '可选：显式填充位；与 style 互斥' },
              stroke: { type: 'boolean', description: '可选：显式外框位；与 style 互斥' },
              x: { type: 'number', description: 'rect/text 的 x（画布 CSS px）' },
              y: { type: 'number', description: 'rect 的左上 y；text 的基线 y（画布 CSS px）' },
              width: { type: 'number', description: 'rect 宽（>0）' },
              height: { type: 'number', description: 'rect 高（>0）' },
              cx: { type: 'number', description: 'circle 中心 x' },
              cy: { type: 'number', description: 'circle 中心 y' },
              rx: { type: 'number', description: 'circle 半径 x（>0）' },
              ry: { type: 'number', description: 'circle 半径 y（>0）' },
              x1: { type: 'number', description: 'line/arrow 起点 x' },
              y1: { type: 'number', description: 'line/arrow 起点 y' },
              x2: { type: 'number', description: 'line/arrow 终点 x（不得与起点重合）' },
              y2: { type: 'number', description: 'line/arrow 终点 y' },
              points: {
                type: 'array',
                minItems: 2,
                description: 'brush 笔迹：按顺序的 [[x,y],...] 画布坐标点（Host 会按单笔 512 点上限下采样并保留首末点）',
                items: {
                  type: 'array',
                  minItems: 2,
                  maxItems: 2,
                  items: { type: 'number' },
                },
              },
              text: { type: 'string', description: `text 内容（超过 ${ANNOTATION_LIMITS.maxTextCodeUnits} 字符会截断并在 truncation 里计数）` },
              fontSize: {
                type: 'integer',
                description: `可选，只能等于 ${ANNOTATION_LIMITS.textFontSize}（面板文字固定字号，其它值报 font-size-fixed）`,
              },
            },
          },
        },
        ids: {
          type: 'array',
          minItems: 1,
          maxItems: ANNOTATION_AGENT_MAX_SHAPES_PER_CALL,
          description: 'erase 专用：要删除的图形 id（形如 a12）。与 point 至少给一个；不存在的 id 只是不命中，不报错。',
          items: { type: 'string' },
        },
        point: {
          type: 'object',
          additionalProperties: false,
          required: ['x', 'y'],
          description: 'erase 专用：橡皮擦命中点（画布 CSS px）。命中规则见文档：形状几何到该点距离 ≤ max(radius, strokeWidth/2, 6)。',
          properties: {
            x: { type: 'number', description: '命中点 x（画布 CSS px）' },
            y: { type: 'number', description: '命中点 y（画布 CSS px）' },
            radius: { type: 'number', description: `可选半径，默认 ${ANNOTATION_ERASE_DEFAULT_RADIUS}（1–4096）` },
          },
        },
        expectRevision: {
          type: 'integer',
          description: '可选 CAS：与当前文档 revision 不同则 ANNOTATION_REVISION_CONFLICT（零写入，返回 currentRevision）',
        },
      },
    },
    output: { schema: { type: 'object' }, render: (args, value) => text(value) },
    async execute(args, exec) {
      const call = normalizeAgentAnnotationCall(args);
      return exec.runtime.agentAnnotation(call, { sessionId: exec.sessionId });
    },
  });
  register({
    name: 'browser_security_scope',
    // status is a cached host read; set/stop reconfigure the boundary in Host memory only —
    // no CDP, no page lease, no browser startup (the store lives on the Runtime).
    readOnly: (args) => Boolean(args) && typeof args === 'object' && args.action === 'status',
    hostOnly: (args) => Boolean(args) && typeof args === 'object' && args.action !== 'status',
    description: '安全测试授权边界（FR-01 Scope & Safety Controller）：为当前运行环境建立 Origin 白名单、路径约束、'
      + '请求预算（maxRequests/maxConcurrent/timeWindowMs）与被动/主动模式，并提供不可撤销的停止开关。'
      + 'status=只读查看当前边界与计数（scope 未启用时说明如何启用）；set=建立或重配置边界（allowedOrigins 必须是精确 Origin '
      + '协议+主机+端口；allowedPaths 可选路径前缀；mode=passive 默认只允许被动探索，主动派发需 mode=active）；'
      + 'stop=停止本会话 scope：之后 0 次新派发且不可恢复，重配需新会话。'
      + '一旦 set 生效，后续每次导航（含重定向落点）与 Cookie 导出读取都在派发前逐次校验：越界 Origin/路径、超预算、'
      + '超并发或被动模式下的主动派发都以 0 次实际派发拒绝并留审计（SECURITY_SCOPE_* 错误码）。'
      + '不 set 时普通 GUI 测试完全不受影响。',
    parameters: {
      type: 'object',
      additionalProperties: false,
      required: ['action'],
      properties: {
        action: { type: 'string', enum: ['status', 'set', 'stop'], description: 'status=查看边界与计数；set=建立/重配置；stop=停止（不可撤销）' },
        allowedOrigins: { type: 'array', minItems: 1, maxItems: 16, items: { type: 'string' }, description: 'set 专用：精确 Origin 白名单（如 http://127.0.0.1:8088）' },
        allowedPaths: { type: 'array', maxItems: 16, items: { type: 'string' }, description: 'set 专用：可选路径前缀约束（如 /api）' },
        maxRequests: { type: 'integer', description: 'set 专用：时间窗内最大请求数（默认 500）' },
        maxConcurrent: { type: 'integer', description: 'set 专用：最大并发（默认 4，上限 16）' },
        maxRequestsPerSecond: { type: 'integer', description: 'set 专用：每秒派发上限（默认 20，上限 1000；0=关闭速率限制）' },
        timeWindowMs: { type: 'integer', description: 'set 专用：预算时间窗毫秒（默认 30 分钟）' },
        mode: { type: 'string', enum: ['passive', 'active'], description: 'set 专用：passive=仅被动探索（默认）；active=允许主动测试' },
        expectedConfigRevision: { type: 'integer', description: 'set 专用可选 CAS：重配置时与当前 configRevision 不同则拒绝' },
        reason: { type: 'string', description: 'stop 专用：停止原因（进审计）' },
      },
    },
    output: { schema: { type: 'object' }, render: (args, value) => text(value) },
    async execute(args, exec) {
      return exec.runtime.securityScopeOp(args || {}, exec);
    },
  });
  register({
    name: 'browser_surface',
    hostOnly: (args) => Boolean(args) && typeof args === 'object' && args.action === 'build',
    description: '攻击面发现（FR-02）：build=从网络采集事件与当前页面 DOM 事实构建结构化 Attack Surface Inventory。'
      + '输出 apiOperations（method/path/参数来源/认证观测/状态码观测，全部 observed=网络实发）、pageRoutes（页面路由，observed）、'
      + 'forms（表单 action/method/字段，inferred=可发起但未实发）、unverifiedPaths（调用方注入的静态线索，unverified）。'
      + '证据分级是契约：JS 字符串里的路径不代表接口可用；每个操作可回链到首次观测的 seq。'
      + '不主动派发任何请求：只读采集缓冲与当前页面 DOM。',
    parameters: {
      type: 'object',
      additionalProperties: false,
      required: ['action'],
      properties: {
        action: { type: 'string', enum: ['build'], description: 'build=构建当前 Inventory' },
        origin: { type: 'string', description: '可选：限定 Origin（默认当前 Tab 精确 Origin）' },
        unverifiedPaths: { type: 'array', items: { type: 'string' }, description: '可选：来自静态线索（JS 字符串等）的路径，标记为 unverified' },
      },
    },
    output: { schema: { type: 'object' }, render: (args, value) => text(value) },
    async execute(args, exec) {
      const action = String((args && args.action) || '');
      if (action !== 'build') {
        throw new BrowserError('INVALID_ARGUMENT', 'surface.action 不合法: ' + action, { allowed: ['build'] });
      }
      return exec.runtime.surfaceBuild(args || {}, exec);
    },
  });
  register({
    name: 'browser_biz',
    readOnly: (args) => Boolean(args) && typeof args === 'object' && args.action === 'evaluate',
    hostOnly: (args) => Boolean(args) && typeof args === 'object',
    description: '业务逻辑测试（FR-08/BIZ-01..05）：判定基于**服务端最终状态**而非请求本身。'
      + 'evaluate=对已观测事实跑不变量检查（数量/价格边界、优惠券重复累加、客户端金额信任、重复提交幂等、非法状态迁移），'
      + '返回候选与其允许状态（候选永不为 confirmed）；'
      + 'probe=按场景模板执行受控请求并采集服务端状态：cart-quantity（边界数量→读服务端购物车）、'
      + 'coupon-reuse（同码多次应用→读折扣）、order-state（只读状态基线）、snapshot（购物车/订单/商品只读快照）。'
      + '所有 probe 请求都经过 scope 闸门（origin/路径/预算/危险操作），并受被动/主动模式约束。'
      + 'BIZ-05 硬规则：每个确认问题至少 2 次可重复观测，1 次只能计为候选。',
    parameters: {
      type: 'object',
      additionalProperties: false,
      required: ['action'],
      properties: {
        action: { type: 'string', enum: ['evaluate', 'probe'], description: 'evaluate=检查已观测事实；probe=执行受控场景采集' },
        facts: { type: 'object', description: 'evaluate 专用：quantityBoundaries/couponReuse/clientTrust/duplicateSubmission/stateTransition/reproducibility' },
        scenario: { type: 'string', enum: ['cart-quantity', 'coupon-reuse', 'order-state', 'snapshot'], description: 'probe 专用场景' },
        variants: { type: 'array', items: { type: 'integer' }, description: 'cart-quantity 专用：要尝试的数量（默认 [-5,0,100000]）' },
        productId: { type: 'integer', description: 'cart-quantity 专用：商品 id（默认 1）' },
        code: { type: 'string', description: 'coupon-reuse 专用：券码（默认 WELCOME10）' },
        times: { type: 'integer', description: 'coupon-reuse 专用：应用次数（默认 2，上限 5）' },
        basePath: { type: 'string', description: '可选：目标 base（默认当前 Origin）' },
      },
    },
    output: { schema: { type: 'object' }, render: (args, value) => text(value) },
    async execute(args, exec) {
      const action = String((args && args.action) || '');
      if (action === 'evaluate') return exec.runtime.bizEvaluate(args || {});
      if (action === 'probe') return exec.runtime.bizProbe(args || {}, exec);
      throw new BrowserError('BIZ_INVALID_ARGUMENT', 'biz.action 不合法: ' + action, { allowed: ['evaluate', 'probe'] });
    },
  });
  register({
    name: 'browser_findings',
    // Findings live in Host memory: reads are cached host reads, writes touch only this scope's
    // own record list. No CDP, no page, no lease.
    readOnly: (args) => Boolean(args) && typeof args === 'object'
      && ['list', 'grade', 'report', 'evaluate'].includes(args.action),
    hostOnly: (args) => Boolean(args) && typeof args === 'object'
      && ['add', 'retest', 'reproduce'].includes(args.action),
    description: '安全 Finding 与证据闭环（FR-09/FR-10）：add=登记一条 Finding；evaluate=对观测事实跑安全规则'
      + '（匿名访问/横向纵向授权/参数篡改/注入/DOM+存储型 XSS/CORS/安全头/调试端点/客户端金额信任），返回候选；'
      + 'list=清单与汇总；grade=单条证据完整度（必填字段+请求/响应+UI/源码关联）；report=结构化报告并做凭据 canary 自检；'
      + 'retest=记录复测（复现次数增加或对照成立）；'
      + 'reproduce=**真实重放** Finding 记录的请求并比对服务端回答（经 scope 闸门），给出能否独立复现（EVD-05）。'
      + '**状态只能由证据类型推导**：static-pattern→potential、observed-once→likely、differential/reproduced 且 ≥2 次复现+对照→confirmed；'
      + '调用方请求的更高状态会被降级并在 notes 里说明原因。High/Critical 证据完整率必须 100% 才算达标。',
    parameters: {
      type: 'object',
      additionalProperties: false,
      required: ['action'],
      properties: {
        action: { type: 'string', enum: ['add', 'evaluate', 'list', 'grade', 'report', 'retest', 'reproduce'], description: '操作' },
        findingId: { type: 'string', description: 'add 可选（默认自动编号）/ grade/retest 必填' },
        title: { type: 'string' }, category: { type: 'string' },
        severity: { type: 'string', enum: ['critical', 'high', 'medium', 'low'] },
        confidence: { type: 'number', description: '0–1' },
        targetUrl: { type: 'string' }, endpoint: { type: 'string' }, identity: { type: 'string' },
        preconditions: { type: 'array', items: { type: 'string' } },
        reproductionSteps: { type: 'array', items: { type: 'string' } },
        evidence: { type: 'object' }, request: { type: 'object' }, response: { type: 'object' },
        dom: { type: 'object' }, screenshot: { type: 'object' }, scriptLocation: { type: 'object' },
        networkSeq: { type: 'integer' },
        impact: { type: 'string' }, remediation: { type: 'string' },
        evidenceBasis: { type: 'string', enum: ['reproduced', 'differential', 'observed-once', 'static-pattern', 'disproved'] },
        reproductions: { type: 'integer' }, hasContrast: { type: 'boolean' },
        status: { type: 'string', enum: ['confirmed', 'likely', 'potential', 'false_positive'], description: '仅作请求；实际状态由证据推导' },
        facts: { type: 'object', description: 'evaluate 专用：观测事实（anonAccess/cors/securityHeaders/... 分组）' },
        severityFilter: { type: 'string' }, statusFilter: { type: 'string' },
        canaries: { type: 'array', items: { type: 'string' }, description: 'report 专用：需要扫描的敏感值（如已导出 Cookie 值）' },
        reproduced: { type: 'boolean', description: 'retest 专用：本次是否复现' },
        note: { type: 'string' },
      },
    },
    output: { schema: { type: 'object' }, render: (args, value) => text(value) },
    async execute(args, exec) {
      const action = String((args && args.action) || '');
      const input = args || {};
      if (action === 'add') return exec.runtime.findingsAdd(input, exec);
      if (action === 'evaluate') return exec.runtime.findingsEvaluate(input);
      if (action === 'list') return exec.runtime.findingsList({ ...input, severity: input.severityFilter ?? input.severity, status: input.statusFilter ?? input.status });
      if (action === 'grade') return exec.runtime.findingsGrade(input);
      if (action === 'report') return exec.runtime.findingsReport(input);
      if (action === 'retest') return exec.runtime.findingsRetest(input);
      if (action === 'reproduce') return exec.runtime.findingsReproduce(input, exec);
      throw new BrowserError('FINDING_INVALID_ARGUMENT', 'findings.action 不合法: ' + action, {
        allowed: ['add', 'evaluate', 'list', 'grade', 'report', 'retest'],
      });
    },
  });
  register({
    name: 'browser_script',
    // `list` reads collected descriptors only; every other action issues CDP Debugger commands
    // against the current page — host-level work (no page queue, no single-owner lease).
    readOnly: (args) => Boolean(args) && typeof args === 'object'
      && ['list', 'stack', 'scope', 'correlate', 'verify'].includes(args.action),
    hostOnly: (args) => Boolean(args) && typeof args === 'object'
      && args.action !== 'list',
    description: 'JavaScript 静态分析（FR-03/FR-04）：Debugger 域按需启用（armed=true 才 Debugger.enable，'
      + '属入侵性能力）。list=已加载脚本清单（scriptId/URL/来源 inline|external|dynamic|worker/字节/Source Map 是否存在/'
      + 'sha256 内容指纹，不含内容）；source=取回脚本源码（含 sha256 与 Source Map 可达性三态）；'
      + 'format=压缩代码格式化（明确标注 isOriginalSource:false，并给逐行原始位置映射 lineMap）；'
      + 'strings=字符串表识别与还原（base64/hex/unicode-escape 可确定还原标 decoded，本来可读标 plain，无法还原标 unknown——绝不伪造）；'
      + 'sinks=Source-to-Sink 静态定位（location/document.cookie/input → innerHTML/eval/document.write 等，带 high/medium/low 置信度，'
      + 'low 表示只找到 sink 未找到来源，不能声称可利用）；analyze=综合结论，可用 runtimeValues 做静态/运行时一致性对照（JS-08）。'
      + '运行时分析（RT-01..07）：breakpoint 设置/列出/移除 URL 断点（命中计数如实为 0 或真实次数）；'
      + 'stack 返回最近暂停的调用栈（不含 live handle）；scope 返回作用域变量但默认脱敏（cookie/token/session/签名/盐只回类型与长度）；'
      + 'resume 恢复执行；correlate 把暂停栈与网络请求关联（confirmed/likely/possible，possible 明确不是因果）；'
      + 'verify 逐项比对静态签名结论与运行时参数（缺失项不算一致，敏感项只比形态）。'
      + '暂停有硬超时：超时即自动 Debugger.resume，页面不会因调试永久挂起。'
      + '未 armed 时返回 armed:false 的结构化状态，不伪装成“没有脚本”。',
    parameters: {
      type: 'object',
      additionalProperties: false,
      required: ['action'],
      properties: {
        action: {
          type: 'string',
          enum: ['list', 'armed', 'source', 'format', 'strings', 'sinks', 'analyze',
            'breakpoint', 'stack', 'scope', 'resume', 'correlate', 'verify'],
          description: 'list=清单；armed=启用 Debugger；（静态）source/format/strings/sinks/analyze；'
            + '（运行时）breakpoint=设置/列出/移除断点，stack=暂停调用栈，scope=暂停作用域变量（默认脱敏），'
            + 'resume=恢复执行，correlate=暂停栈与请求关联，verify=静态签名结论与运行时参数比对',
        },
        op: { type: 'string', enum: ['set', 'list', 'remove'], description: 'breakpoint 专用：set/list/remove（默认 set）' },
        lineNumber: { type: 'integer', description: 'breakpoint set 专用：0 起算的源码行号' },
        columnNumber: { type: 'integer', description: 'breakpoint set 专用：0 起算列号（默认 0）' },
        condition: { type: 'string', description: 'breakpoint set 专用：条件表达式（CDP condition）' },
        label: { type: 'string', description: '断点的人可读标签（用于 remove 与审计）' },
        cdpBreakpointId: { type: 'string', description: 'breakpoint remove 专用：CDP breakpointId' },
        scopeIndex: { type: 'integer', description: 'scope 专用：只取第 N 个作用域（省略=全部）' },
        limit: { type: 'integer', description: 'correlate 专用：最近 N 个请求（默认 10，上限 50）' },
        beforeMs: { type: 'integer', description: 'correlate 专用：请求早于暂停的最大毫秒（默认 250）' },
        afterMs: { type: 'integer', description: 'correlate 专用：请求晚于暂停的最大毫秒（默认 1000）' },
        expected: { type: 'object', description: 'verify 专用：静态逆向结论（name→value）' },
        observed: { type: 'object', description: 'verify 专用：运行时观测到的参数（name→value）' },
        scriptId: { type: 'string', description: 'scriptId（与 url 二选一；省略时用 url 精确匹配）' },
        url: { type: 'string', description: '脚本 URL（精确匹配）' },
        runtimeValues: { type: 'object', description: 'analyze 专用：运行时观测到的值，用于静态/运行时一致性对照（JS-08）' },
      },
    },
    output: { schema: { type: 'object' }, render: (args, value) => text(value) },
    async execute(args, exec) {
      const action = String((args && args.action) || '');
      if (action === 'list') return exec.runtime.scriptInventory();
      if (action === 'armed') return exec.runtime.scriptArm(exec.signal);
      if (action === 'source') return exec.runtime.scriptSource(args || {}, exec.signal);
      if (action === 'format') return exec.runtime.scriptFormat(args || {}, exec.signal);
      if (action === 'strings') return exec.runtime.scriptStrings(args || {}, exec.signal);
      if (action === 'sinks') return exec.runtime.scriptSinks(args || {}, exec.signal);
      if (action === 'analyze') return exec.runtime.scriptAnalyze(args || {}, exec.signal);
      if (action === 'breakpoint') return exec.runtime.scriptBreakpoint(args || {}, exec.signal);
      if (action === 'stack') return exec.runtime.scriptStack(args || {}, exec.signal);
      if (action === 'scope') return exec.runtime.scriptScope(args || {}, exec.signal);
      if (action === 'resume') return exec.runtime.scriptResume(exec.signal);
      if (action === 'correlate') return exec.runtime.scriptCorrelate(args || {});
      if (action === 'verify') return exec.runtime.scriptVerify(args || {});
      throw new BrowserError('SCRIPT_INVALID_ARGUMENT', 'script.action 不合法: ' + action, {
        allowed: ['list', 'armed', 'source', 'format', 'strings', 'sinks', 'analyze',
          'breakpoint', 'stack', 'scope', 'resume', 'correlate', 'verify'],
      });
    },
  });
  register({
    name: 'browser_cookies',
    // metadata is a cache-free host read (CDP without a page lease); export/import bind to the
    // runtime+tab (same-origin + human approval) and never take the page queue or the lease.
    readOnly: (args) => Boolean(args) && typeof args === 'object' && args.action === 'metadata',
    hostOnly: (args) => Boolean(args) && typeof args === 'object' && args.action !== 'metadata',    description: 'Cookie Store 读取与受控凭据导出/导入（FR-11）。metadata=当前标签页精确 Origin 的 Cookie 元数据'
      + '（名称/Domain/Path/Expires/Secure/HttpOnly/SameSite；永不返回 value，包括 HttpOnly）；'
      + 'export=把当前 Origin 的 Cookie 明文导出到受控文件——必须先由人类在插件配置目录的 security-approvals.json 签发授权'
      + '（绑定 workspace/runtime/tab/origin，一次性、带过期时间；HttpOnly 需记录内 allowHttpOnly:true 专项授权），'
      + 'Agent 传入的任何 confirm 字符串都无效；明文只写入持久根内 0600 的 .json 文件，工具响应/日志/网络证据零泄漏，'
      + '超限整次失败不截断；import=把本工具导出的快照回填当前标签页会话（HttpOnly 条目需 importHttpOnly:true 显式开启）。'
      + '注意：获得授权的导出即搬运当前浏览器登录态；请配合站点侧会话撤销使用。',
    parameters: {
      type: 'object',
      additionalProperties: false,
      required: ['action'],
      properties: {
        action: {
          type: 'string',
          enum: ['metadata', 'export', 'import'],
          description: 'metadata=读元数据（无授权要求）；export=受控导出（人类授权必需）；import=回填快照',
        },
        out: { type: 'string', description: 'export 专用：持久根内相对路径（.json）；已存在则拒绝（不覆盖）' },
        allowHttpOnly: { type: 'boolean', description: 'export 专用：请求包含 HttpOnly 条目；仅当授权记录内 allowHttpOnly:true 时生效，否则 COOKIE_HTTPONLY_FORBIDDEN' },
        data: { type: 'string', description: 'import 专用：内联快照 JSON（与 file 二选一）' },
        file: { type: 'string', description: 'import 专用：持久根内相对路径（与 data 二选一）' },
        importHttpOnly: { type: 'boolean', description: 'import 专用：允许回填 HttpOnly 条目（默认 false）' },
      },
    },
    output: { schema: { type: 'object' }, render: (args, value) => text(value) },
    async execute(args, exec) {
      const action = String((args && args.action) || '');
      if (action === 'metadata') return exec.runtime.cookieMetadata(args || {}, exec);
      if (action === 'export') return exec.runtime.cookieExport(args || {}, exec);
      if (action === 'import') return exec.runtime.cookieImport(args || {}, exec);
      throw new BrowserError('COOKIE_INVALID_ARGUMENT', 'cookies.action 不合法: ' + action, { allowed: ['metadata', 'export', 'import'] });
    },
  });
  register({
    name: 'browser_state',
    description: '读取内嵌浏览器的当前状态：地址、标题、视口（旧 {width,height}、安全 view 投影与 canvas 画布投影）、控制权归属。'
      + '不保证新鲜：需要确定更新后事实请用 browser_viewport set 的读回，或 browser_viewport get 的缓存诊断。',
    parameters: { type: 'object', properties: {}, required: [] },
    output: { schema: { type: 'object' }, render: (args, value) => text(value) },
    async execute(args, exec) {
      if (!exec.runtime) {
        // Neutral diagnostic outside the Web environment (fake contract environment, or a Web
        // environment the user disabled): report the environment-scoped truth instead of failing
        // or starting a page. Nothing here claims a bound Web target.
        const snapshot = crossEnvironment.snapshotForAgent(exec.agent);
        return {
          mode: 'idle',
          activity: '空闲',
          url: '',
          environment: snapshot.environment,
          adapterId: snapshot.adapterId,
          configRevision: snapshot.revision,
          enabledEnvironments: snapshot.enabledEnvironments,
          running: false,
          target: null,
          note: 'no Web runtime: this environment has no page target (environment-neutral diagnostic)',
        };
      }
      await exec.runtime.refreshTitle(exec.signal);
      // Page-state ↔ network correlation (§3.3 / G2.6): one state mark per state read so the
      // timeline can replay url/title/revision changes next to the traffic they belong to.
      exec.runtime.netMark({ kind: 'state', text: 'state', url: exec.runtime.url });
      return exec.runtime.state();
    },
  });

  return {
    definitions,
    /** Attach (or detach) the Host attachment service for image delivery. */
    setAttachments(service) {
      attachments = service ?? null;
    },
  };
}
