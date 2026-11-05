/**
 * dynamic-t4.js — WEB-T4 动态行为的**纯核心**（零 CDP / 零文件系统 / 零网络 / 零 npm 依赖）。
 *
 * 权威契约：
 *  - docs/t4-dynamic-behavior.md（时钟/事件/ID 域/有界存储）、§3.4（七原语）、§5（DC）、
 *    §7.2/§7.3（工具参数与错误草案）、§8（U 类验收口径）。
 *  - docs/t4-dynamic-behavior.md（advisor 冻结的导出名/签名/错误码；落后于本文件时以契约为准）。
 *
 * 边界（本文件只做纯逻辑）：
 *  - 不做 CDP、不启动浏览器、不读写文件、不读环境变量、不建目录、不申请租约；无全局可变状态。
 *  - 帧的**采集**（screencast sink、ACK、队列、会话状态机）与 PNG 解码在 Host；本文件只做
 *    有界存储、时间轴、分析、断言汇总与关联。PNG 复用 vision-t3.js 的 diffImages；JPEG 由本
 *    文件的 `decodeJpegRgba` 纯 JS 解码（screencast 帧是 JPEG）。
 *  - 除随机 ID（randomBytes）外无不确定性；不接受 `Date.now()` 之外的隐式时钟（构造可注入 now）。
 *  - 时间缺失一律 null，不用接收时刻回填 sourceTimestamp；未知/跨会话 ID 同形 NOT_FOUND。
 *
 * 自定的实现口径（契约未逐字规定，集中在此声明，供 Host/验收引用）：
 *  - 断言“极性”逐类型固定（沿实施契约 §2.4，不是同一个比较方向）：
 *      frame-diff / region-change：**稳定性检查**——任一相邻可比对 diffRatio >= changeRatio 即 FAIL；
 *      flicker / freeze / jank：**异常检测**——检出符合定义的异常即 FAIL（JPEG 正证据保留 FAIL 但 precise=false）；
 *      trajectory：唯一且连续跟踪为 PASS，歧义 INCONCLUSIVE，超过 maxStep 且身份确定为 FAIL；
 *      transition：观测到启动且连续 stableSamples 稳定为 PASS，未观测完整边界为 INCONCLUSIVE。
 *    证据不足时返回 INCONCLUSIVE/BLOCKED，绝不因为“没看见”直接 PASS。
 *  - 分母为 0 / 全 mask：捕获 vision-t3 的 VISION_EMPTY_COMPARISON，返回
 *    verdict=INCONCLUSIVE(reason=empty-comparison)，**不返回 similarity=1**；只有预检即可判定
 *    的纯非法参数（越界 rect、未知阈值键等）才抛 DYNAMIC_INVALID_ARGUMENT。
 *  - 时钟不确定（无锚点/源时间回退/uncertaintyMs>10）只作 `classifications` 标记并降级精确时序
 *    结论，不抛异常（Lead 2026-11-04 裁决）。
 *  - 相邻帧 seq 不连续 = 缺中间帧（gap）。负结论（“没有变化/没有闪烁/没有冻结/没有卡顿”）遇到
 *    gap、缺源时间或采集完整性未知时一律 INCONCLUSIVE；正结论（看见了变化/闪烁/跳变）不受
 *    gap 影响，但记 limitations。
 *  - 帧 `sourceTimestamp` 单位是**秒**（CDP screencast metadata.timestamp），缺失为 null；
 *    `receivedMonoMs` 是 Host 单调时钟（毫秒），两者不互相填充。
 *  - JPEG：`decodeJpegRgba` 为纯 JS baseline/extended-sequential 解码（SOF0/SOF1、4:2:0/4:2:2/4:4:4、
 *    自定义 DHT、DRI/RST）；progressive/arithmetic/16-bit 返回 `{ok:false,code:'DECODER_UNSUPPORTED'}`。
 *    `addFrame` **不解码**（ACK 路径不付解码成本）；`runMotionAssertions` 在需要像素时对带
 *    `bytes+encoding` 的帧自动 materialize（jank-only 不解码）；解码失败仅使相关断言
 *    INCONCLUSIVE(decoder-unavailable)，不会拿字节长度/哈希冒充像素。
 *  - DC 候选预筛（Lead 2026-11-04 裁决）：同域方向（visual->visual / network->network）先按
 *    `|Δt| <= beforeMs + afterMs`（默认 250+1000=1250ms，含双方 uncertainty）滑动窗口预筛，
 *    只有窗口内候选才消耗 `maxCandidateCompares`（40000）；跨域方向保持完整候选枚举。
 *    `suppressedTemporal` 与 temporal pair 走同一预筛路径；结果附 `diagnostics`
 *    （`estimatedPairComparisons`/`maxCandidateCompares`/`directionComparisons`/`prefilter`）。
 *  - 预算：`runMotionAssertions`/`runMotionAssertionsAsync` 共用一次性累计 5000ms 预算和 signal；
 *    原语在相邻帧/候选检查点检查预算，超限把剩余断言标 BLOCKED(dynamic-timeout)，不交付半成品 PASS。
 *    同步原语内部仍逐对同步（重活由 T3 diffImages 自带的取消/预算检查兜底），异步变体只在断言边界
 *    让出事件循环，结果会明确带 `sync-variant-checks-at-pair-boundaries`/`scheduling` 字段。
 *  - 帧证据 hash 分列：`encodedSha256`（编码字节）与 `rgbaSha256`（解码像素），不得互相冒充。
 *  - 断言阈值形状沿 §7.2 的表；`expectedIntervalMs` 只属 jank，`query` 只属 trajectory，
 *    `expectation` 只属 freeze。
 */

import { createHash, randomBytes } from 'node:crypto';

import { BrowserError } from './browser-safety.js';
import {
  cropImage,
  decodePngToRgba,
  diffImages,
  findInImage,
  mappingCompatible,
  validateMasks,
  validatePixelRect,
} from './vision-t3.js';

/* ------------------------------------------------------------------ */
/* 常量                                                               */
/* ------------------------------------------------------------------ */

export const T4_VERSION = 1;
export const T4_ALGORITHM_VERSION = 't4-draft-v1';
export const DC_ALGORITHM_VERSION = 'dc-draft-v1';
export const JPEG_DECODER_ID = 't4-jpeg-baseline-v1';

export const T4_LIMITS = Object.freeze({
  maxActiveSessions: 1,
  retainedSessions: 4,
  durationMs: 3000,
  // Lead 裁决（2026-11-04）：Agent 一次工具往返实测 11.7s，原 hard 上限 10000ms 使
  // 「start 视觉会话 → 操作 → 仍在 running」在真机不可达（观测全落进 retained 分支）。
  // 放宽到 60000ms 仍是有界上限，且不联动其它预算：帧/字节/算法预算不随会话时长放大
  // （180/300 帧、32/64 MiB、5000ms）；`recalibrateAfterMs` 仍固定 10000ms；
  // seek/分析阈值里的 10000ms 边界（timeMs 0–10000、DurationMs 0–10000）不变；
  // 不新增 extend/keepalive，fresh 与幂等 start 都不续期。
  durationMsHard: 60000,
  // 会话续约（extend）纯资源上限：单次续约上限与 durationMsHard 一致（60000ms），
  // 自 startedAt 起的累计会话总时长上限 300000ms（5min）。两者只限制采集时长，
  // 不放大帧/字节/事件/算法/校准等任何其它预算。
  maxSessionExtendMs: 60000,
  sessionCapMs: 300000,
  maxFrames: 180,
  maxFramesHard: 300,
  maxBytes: 32 * 1024 * 1024,
  maxBytesHard: 64 * 1024 * 1024,
  maxFramePixels: 4000000,
  maxFrameBytes: 8 * 1024 * 1024,
  maxEvents: 5000,
  maxEventsHard: 20000,
  maxRegions: 100,
  maxEvidenceBytes: 262144,
  maxWorkingSetBytes: 256 * 1024 * 1024,
  algorithmBudgetMs: 5000,
  correlationPageSize: 200,
  maxCandidateCompares: 40000,
  correlationBeforeMs: 250,
  correlationAfterMs: 1000,
  maxCorrelationBeforeMs: 5000,
  maxCorrelationAfterMs: 5000,
  maxCalibrationSamples: 5,
  maxClockUncertaintyMs: 10,
  recalibrateAfterMs: 10000,
  maxImagesPerObserve: 3,
  sampleIntervalMsMin: 50,
  sampleIntervalMsMax: 1000,
  scaleMin: 0.1,
  scaleMax: 2,
  maxControlTargets: 20,
  maxAssertions: 20,
  maxIds: 200,
  maxMasks: 64,
});

/**
 * 动态会话时长校验（纯函数）：默认 3000ms，允许 1..60000ms（durationMsHard）。
 * 只限制单段采集的有界时长；不放大帧/字节/事件/算法预算，也不改变重校准间隔。
 */
export function validateSessionDuration(value) {
  if (value === undefined || value === null) return T4_LIMITS.durationMs;
  if (typeof value !== 'number' || !Number.isFinite(value) || !Number.isInteger(value)) {
    badArgument('durationMs', 'not-an-integer', 'sessionDuration');
  }
  if (value < 1) badArgument('durationMs', 'below-min:1', 'sessionDuration');
  if (value > T4_LIMITS.durationMsHard) {
    badArgument('durationMs', `above-max:${T4_LIMITS.durationMsHard}`, 'sessionDuration');
  }
  return value;
}

function extendRejection(code, field, limit, actual, max, message) {
  const numericActual = typeof actual === 'number' && Number.isFinite(actual) ? actual : null;
  return { ok: false, code, field, limit, actual: numericActual, max, message };
}

/**
 * 会话续约（extend）纯校验（Lead 冻结语义 2026-11-04）：
 *  - 单次续约 1..maxSessionExtendMs（60000ms，与 durationMsHard 一致）；
 *  - 自 startedAt 起的累计总时长不得超过 sessionCapMs（300000ms）；
 *  - newDeadlineMs = max(deadlineMs, nowMonoMs) + extendMs：会话仍活着时从原 deadline 续，
 *    已过 deadline 的情形不应出现（Host 只在 running 调用），但这里仍从 now 起算以保持稳健；
 *  - cumulativeMs = newDeadlineMs - startedAt；
 *  - 纯资源上限，不放大帧/字节/事件/算法/校准任何其它预算；不做 IO、不抛错，
 *    由 Host 决定抛 DYNAMIC_INVALID_ARGUMENT 还是 DYNAMIC_LIMIT_EXCEEDED。
 */
export function validateSessionExtend(input = {}) {
  if (!isPlainObject(input)) {
    return extendRejection('DYNAMIC_INVALID_ARGUMENT', 'input', null, null, null, 'input must be an object');
  }
  const allowed = ['durationMs', 'startedAt', 'deadlineMs', 'nowMonoMs'];
  for (const key of Object.keys(input)) {
    if (!allowed.includes(key)) {
      return extendRejection('DYNAMIC_INVALID_ARGUMENT', key, null, null, null, `unknown field: ${key}`);
    }
  }
  const { durationMs, startedAt, deadlineMs, nowMonoMs } = input;
  if (typeof startedAt !== 'number' || !Number.isFinite(startedAt)) {
    return extendRejection('DYNAMIC_INVALID_ARGUMENT', 'startedAt', null, startedAt, null, 'startedAt must be a finite number');
  }
  if (typeof deadlineMs !== 'number' || !Number.isFinite(deadlineMs)) {
    return extendRejection('DYNAMIC_INVALID_ARGUMENT', 'deadlineMs', null, deadlineMs, null, 'deadlineMs must be a finite number');
  }
  if (typeof nowMonoMs !== 'number' || !Number.isFinite(nowMonoMs)) {
    return extendRejection('DYNAMIC_INVALID_ARGUMENT', 'nowMonoMs', null, nowMonoMs, null, 'nowMonoMs must be a finite number');
  }
  if (typeof durationMs !== 'number' || !Number.isFinite(durationMs) || !Number.isInteger(durationMs)) {
    return extendRejection(
      'DYNAMIC_INVALID_ARGUMENT', 'durationMs', 'maxSessionExtendMs', durationMs,
      T4_LIMITS.maxSessionExtendMs, 'extendMs must be an integer',
    );
  }
  if (durationMs < 1) {
    return extendRejection(
      'DYNAMIC_INVALID_ARGUMENT', 'durationMs', 'maxSessionExtendMs', durationMs,
      T4_LIMITS.maxSessionExtendMs, 'extendMs must be >= 1',
    );
  }
  if (durationMs > T4_LIMITS.maxSessionExtendMs) {
    return extendRejection(
      'DYNAMIC_INVALID_ARGUMENT', 'durationMs', 'maxSessionExtendMs', durationMs,
      T4_LIMITS.maxSessionExtendMs, 'extendMs exceeds maxSessionExtendMs',
    );
  }
  const baseDeadlineMs = Math.max(deadlineMs, nowMonoMs);
  const newDeadlineMs = baseDeadlineMs + durationMs;
  const cumulativeMs = newDeadlineMs - startedAt;
  if (cumulativeMs > T4_LIMITS.sessionCapMs) {
    return extendRejection(
      'DYNAMIC_LIMIT_EXCEEDED', 'cumulativeMs', 'sessionCapMs', cumulativeMs,
      T4_LIMITS.sessionCapMs, 'cumulative session duration exceeds sessionCapMs',
    );
  }
  return {
    ok: true,
    extendMs: durationMs,
    previousDeadlineMs: deadlineMs,
    newDeadlineMs,
    cumulativeMs,
  };
}

export const T4_THRESHOLDS = Object.freeze({
  'frame-diff': Object.freeze({
    allowed: Object.freeze(['pixelThreshold', 'changeRatio']),
    defaults: Object.freeze({ pixelThreshold: 0.1, changeRatio: 0.01 }),
  }),
  'region-change': Object.freeze({
    allowed: Object.freeze(['pixelThreshold', 'changeRatio', 'minArea']),
    defaults: Object.freeze({ pixelThreshold: 0.1, changeRatio: 0.01, minArea: 4 }),
  }),
  flicker: Object.freeze({
    allowed: Object.freeze(['pixelThreshold', 'changeRatio', 'stableRatio', 'brightnessDelta', 'maxDurationMs']),
    defaults: Object.freeze({
      pixelThreshold: 0.1,
      changeRatio: 0.2,
      stableRatio: 0.01,
      brightnessDelta: 64,
      maxDurationMs: 100,
    }),
  }),
  freeze: Object.freeze({
    allowed: Object.freeze(['pixelThreshold', 'stableRatio', 'minDurationMs']),
    defaults: Object.freeze({ pixelThreshold: 0.1, stableRatio: 0.001, minDurationMs: 500 }),
  }),
  jank: Object.freeze({
    allowed: Object.freeze(['intervalFactor']),
    defaults: Object.freeze({ intervalFactor: 2 }),
  }),
  trajectory: Object.freeze({
    allowed: Object.freeze(['maxStep']),
    defaults: Object.freeze({ maxStep: 80 }),
  }),
  transition: Object.freeze({
    allowed: Object.freeze(['pixelThreshold', 'changeRatio', 'stableRatio', 'stableSamples']),
    defaults: Object.freeze({ pixelThreshold: 0.1, changeRatio: 0.01, stableRatio: 0.001, stableSamples: 3 }),
  }),
});

export const MOTION_TYPES = Object.freeze([
  'frame-diff',
  'region-change',
  'flicker',
  'freeze',
  'jank',
  'trajectory',
  'transition',
]);

export const MOTION_STATUSES = Object.freeze(['resolved', 'inconclusive', 'blocked']);
export const MOTION_VERDICTS = Object.freeze(['PASS', 'WARN', 'FAIL', 'INCONCLUSIVE', 'BLOCKED']);
export const VERDICT_SEVERITY = Object.freeze({
  PASS: 0, WARN: 1, INCONCLUSIVE: 2, BLOCKED: 3, FAIL: 4,
});
export const EXIT_CODES = Object.freeze({ PASS: 0, WARN: 0, FAIL: 1, BLOCKED: 2, INCONCLUSIVE: 2 });

export const DC_DIRECTIONS = Object.freeze([
  'operation->visual',
  'operation->network',
  'network->visual',
  'visual->network',
  'network->network',
  'visual->visual',
]);

export const DC_BASIS = Object.freeze(['explicit', 'redirect', 'initiator', 'observed', 'temporal']);
export const DC_GRADE_MAP = Object.freeze({
  explicit: 'confirmed-causal',
  redirect: 'confirmed-causal',
  initiator: 'confirmed-causal',
  observed: 'observed-association',
  temporal: 'temporal-proximity',
});
export const DC_CONFIDENCE = Object.freeze(['direct', 'supported', 'weak', 'unknown']);

const BASIS_RANK = Object.freeze({ explicit: 5, redirect: 4, initiator: 4, observed: 3, temporal: 2 });
const DOMAIN_VALUES = Object.freeze(['operation', 'visual', 'network', 'control', 'marker']);
const TRUST_VALUES = Object.freeze(['host-observed', 'cdp-observed', 'page-declared', 'caller-declared']);
const DIRECTION_DOMAINS = Object.freeze({
  'operation->visual': ['operation', 'visual'],
  'operation->network': ['operation', 'network'],
  'network->visual': ['network', 'visual'],
  'visual->network': ['visual', 'network'],
  'network->network': ['network', 'network'],
  'visual->visual': ['visual', 'visual'],
});

/* ------------------------------------------------------------------ */
/* 基础工具                                                            */
/* ------------------------------------------------------------------ */

function isPlainObject(value) {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) return false;
  const proto = Object.getPrototypeOf(value);
  return proto === Object.prototype || proto === null;
}

function hasOwn(object, key) {
  return Object.prototype.hasOwnProperty.call(object, key);
}

function randomId(prefix, bytes = 6) {
  return `${prefix}_${randomBytes(bytes).toString('hex')}`;
}

function badArgument(field, reason, label = 'input') {
  throw new BrowserError(
    'DYNAMIC_INVALID_ARGUMENT',
    `${label}.${field || '<root>'}: ${reason}`,
    { field: field || null, reason, label },
  );
}

function notFound(idKind, id) {
  // 未知、已淘汰、跨会话/跨 scope 一律同形返回，不泄漏存在性。
  return new BrowserError(
    'DYNAMIC_EVENT_NOT_FOUND',
    `${idKind} not found`,
    { idKind },
  );
}

function assertAllowedKeys(value, allowed, label) {
  const allowedSet = new Set(allowed);
  for (const key of Object.keys(value)) {
    if (!allowedSet.has(key)) badArgument(key, 'unknown-field', label);
  }
}

function readNumber(object, key, label, options = {}) {
  const {
    min, max, integer = false, required = false, fallback,
  } = options;
  if (!hasOwn(object, key) || object[key] === undefined) {
    if (required) badArgument(key, 'missing-required-field', label);
    return fallback;
  }
  const value = object[key];
  if (typeof value !== 'number' || !Number.isFinite(value)) badArgument(key, 'not-a-finite-number', label);
  if (integer && !Number.isInteger(value)) badArgument(key, 'not-an-integer', label);
  if (min !== undefined && value < min) badArgument(key, `below-min:${min}`, label);
  if (max !== undefined && value > max) badArgument(key, `above-max:${max}`, label);
  return value;
}

function readNullableNumber(object, key, label, options = {}) {
  if (!hasOwn(object, key) || object[key] === undefined || object[key] === null) return null;
  return readNumber(object, key, label, options);
}

function readString(object, key, label, options = {}) {
  const { required = false, fallback = null, maxBytes = 512, minBytes = 1 } = options;
  if (!hasOwn(object, key) || object[key] === undefined || object[key] === null) {
    if (required) badArgument(key, 'missing-required-field', label);
    return fallback;
  }
  const value = object[key];
  if (typeof value !== 'string') badArgument(key, 'not-a-string', label);
  const bytes = Buffer.byteLength(value, 'utf8');
  if (bytes < minBytes) badArgument(key, 'empty-string', label);
  if (bytes > maxBytes) badArgument(key, 'string-too-long', label);
  return value;
}

function readNullableString(object, key, label, options = {}) {
  if (!hasOwn(object, key) || object[key] === undefined || object[key] === null) return null;
  return readString(object, key, label, options);
}

function readBoolean(object, key, label, fallback = false) {
  if (!hasOwn(object, key) || object[key] === undefined) return fallback;
  if (typeof object[key] !== 'boolean') badArgument(key, 'not-a-boolean', label);
  return object[key];
}

function assertLossless(value, label, depth = 0) {
  if (depth > 20) badArgument(label, 'json-too-deep', label);
  if (value === null) return;
  const type = typeof value;
  if (type === 'string' || type === 'boolean') return;
  if (type === 'number') {
    if (!Number.isFinite(value)) badArgument(label, 'non-finite-number', label);
    return;
  }
  if (type === 'undefined') badArgument(label, 'undefined-value', label);
  if (type === 'bigint' || type === 'function' || type === 'symbol') badArgument(label, `unsupported-value:${type}`, label);
  if (Array.isArray(value)) {
    for (let index = 0; index < value.length; index += 1) assertLossless(value[index], `${label}[${index}]`, depth + 1);
    return;
  }
  if (Buffer.isBuffer(value) || ArrayBuffer.isView(value)) badArgument(label, 'binary-value-not-allowed', label);
  if (!isPlainObject(value)) badArgument(label, 'not-a-plain-object', label);
  for (const key of Object.keys(value)) {
    if (value[key] === undefined) badArgument(`${label}.${key}`, 'undefined-value', label);
    assertLossless(value[key], `${label}.${key}`, depth + 1);
  }
}

function cloneJson(value) {
  return structuredClone(value);
}

function sha256Hex(bytes) {
  return createHash('sha256').update(bytes).digest('hex');
}

function encodeCursor(value) {
  return Buffer.from(JSON.stringify(value), 'utf8').toString('base64url');
}

function decodeCursor(cursor, label = 'cursor') {
  if (typeof cursor !== 'string' || cursor.length === 0) badArgument(label, 'not-a-string', label);
  try {
    const parsed = JSON.parse(Buffer.from(cursor, 'base64url').toString('utf8'));
    if (!isPlainObject(parsed)) throw new Error('not an object');
    return parsed;
  } catch {
    badArgument(label, 'invalid-cursor', label);
    return null;
  }
}

function verdictToExitCode(verdict) {
  if (verdict === 'FAIL') return 1;
  if (verdict === 'BLOCKED' || verdict === 'INCONCLUSIVE') return 2;
  return 0;
}

function aggregateVerdict(verdicts) {
  let worst = 'PASS';
  for (const verdict of verdicts) {
    if ((VERDICT_SEVERITY[verdict] ?? 0) > (VERDICT_SEVERITY[worst] ?? 0)) worst = verdict;
  }
  return worst;
}

function cmpNullableNumber(left, right) {
  if (left === right) return 0;
  if (left === null || left === undefined) return 1;
  if (right === null || right === undefined) return -1;
  return left - right;
}

function cmpString(left, right) {
  if (left === right) return 0;
  if (left === null || left === undefined) return 1;
  if (right === null || right === undefined) return -1;
  return left < right ? -1 : 1;
}

/** 同一数值时间的稳定展示排序：`(timelineMs, seq, eventId)`；null 时间排最后。 */
export function compareTimelineEvents(left, right) {
  const byTime = cmpNullableNumber(left?.ts?.timelineMs ?? null, right?.ts?.timelineMs ?? null);
  if (byTime !== 0) return byTime;
  const bySeq = cmpNullableNumber(
    Number.isInteger(left?.seq) ? left.seq : null,
    Number.isInteger(right?.seq) ? right.seq : null,
  );
  if (bySeq !== 0) return bySeq;
  return cmpString(left?.eventId ?? null, right?.eventId ?? null);
}

export function sortTimeline(events) {
  if (!Array.isArray(events)) badArgument('events', 'not-an-array', 'sortTimeline');
  return [...events].sort(compareTimelineEvents);
}

/* ------------------------------------------------------------------ */
/* 时钟：锚点、时间区间与顺序                                          */
/* ------------------------------------------------------------------ */

/**
 * 一次校准样本：Host 单调时钟包围一次页面读数，中点为估计，半 RTT 为不确定度下界。
 * `offsetMs` 表示“页面时间 + offsetMs = Host 单调时间”。
 */
export function createClockAnchor(input = {}) {
  if (!isPlainObject(input)) badArgument('anchor', 'not-an-object', 'clockAnchor');
  assertAllowedKeys(input, [
    'clockId', 'anchorId', 'sendMonoMs', 'receiveMonoMs', 'pageNowMs', 'pageOriginMs',
    'resolutionMs', 'calibratedAtMonoMs', 'source',
  ], 'clockAnchor');
  const sendMonoMs = readNumber(input, 'sendMonoMs', 'clockAnchor', { required: true, min: 0 });
  const receiveMonoMs = readNumber(input, 'receiveMonoMs', 'clockAnchor', { required: true, min: 0 });
  const pageNowMs = readNumber(input, 'pageNowMs', 'clockAnchor', { required: true, min: 0 });
  if (receiveMonoMs < sendMonoMs) badArgument('receiveMonoMs', 'negative-delay', 'clockAnchor');
  const pageOriginMs = readNullableNumber(input, 'pageOriginMs', 'clockAnchor', { min: 0 });
  const resolutionMs = readNullableNumber(input, 'resolutionMs', 'clockAnchor', { min: 0 });
  const calibratedAtMonoMs = readNullableNumber(input, 'calibratedAtMonoMs', 'clockAnchor', { min: 0 })
    ?? receiveMonoMs;
  const rttMs = receiveMonoMs - sendMonoMs;
  const midpointMonoMs = sendMonoMs + rttMs / 2;
  const anchorId = readNullableString(input, 'anchorId', 'clockAnchor', { maxBytes: 128 }) ?? randomId('anc');
  const clockId = readNullableString(input, 'clockId', 'clockAnchor', { maxBytes: 128 });
  return {
    clockId,
    anchorId,
    offsetMs: midpointMonoMs - pageNowMs,
    uncertaintyMs: rttMs / 2,
    resolutionMs,
    calibratedAtMonoMs,
    sampleCount: 1,
    rttMs,
    maxDeviationMs: 0,
    source: readNullableString(input, 'source', 'clockAnchor', { maxBytes: 64 }) ?? 'page-performance',
    samples: [{ anchorId, offsetMs: midpointMonoMs - pageNowMs, uncertaintyMs: rttMs / 2, rttMs }],
  };
}

/** 多样本合并：选最小 RTT 的样本为 offset，保留样本数与最大偏差。 */
export function mergeClockAnchors(samples) {
  if (!Array.isArray(samples) || samples.length === 0) badArgument('samples', 'empty-array', 'mergeClockAnchors');
  const normalized = samples.map((sample, index) => {
    if (!isPlainObject(sample)) badArgument(`samples[${index}]`, 'not-an-object', 'mergeClockAnchors');
    if (Number.isFinite(sample.offsetMs) && Number.isFinite(sample.uncertaintyMs)) {
      const rttMs = Number.isFinite(sample.rttMs) ? sample.rttMs : sample.uncertaintyMs * 2;
      return {
        anchorId: typeof sample.anchorId === 'string' ? sample.anchorId : null,
        offsetMs: sample.offsetMs,
        uncertaintyMs: sample.uncertaintyMs,
        rttMs,
        resolutionMs: Number.isFinite(sample.resolutionMs) ? sample.resolutionMs : null,
      };
    }
    return createClockAnchor(sample);
  });
  let best = normalized[0];
  for (const sample of normalized) if (sample.rttMs < best.rttMs) best = sample;
  let maxDeviationMs = 0;
  for (const sample of normalized) {
    const deviation = Math.abs(sample.offsetMs - best.offsetMs);
    if (deviation > maxDeviationMs) maxDeviationMs = deviation;
  }
  return {
    clockId: normalized.find((sample) => typeof sample.clockId === 'string')?.clockId ?? null,
    anchorId: randomId('anc'),
    offsetMs: best.offsetMs,
    uncertaintyMs: Math.max(best.uncertaintyMs, maxDeviationMs),
    resolutionMs: best.resolutionMs ?? null,
    calibratedAtMonoMs: null,
    sampleCount: normalized.length,
    rttMs: best.rttMs,
    maxDeviationMs,
    source: 'page-performance',
    samples: normalized,
  };
}

/** 时钟不确定判定：默认精确时序要求 uncertaintyMs <= 10（契约 §2.1）。 */
export function isClockUncertain(value, options = {}) {
  const maxUncertaintyMs = options.maxUncertaintyMs === undefined
    ? T4_LIMITS.maxClockUncertaintyMs
    : options.maxUncertaintyMs;
  if (typeof value === 'number') return !Number.isFinite(value) || value > maxUncertaintyMs;
  if (value === null || value === undefined) return true;
  if (!isPlainObject(value)) return true;
  if (!Number.isFinite(value.uncertaintyMs)) return true;
  return value.uncertaintyMs > maxUncertaintyMs;
}

/** 两个时间区间 [t-u, t+u] 是否重叠；重叠时不得宣称先后。 */
export function intervalsOverlap(left, right) {
  if (!isPlainObject(left) || !isPlainObject(right)) badArgument('interval', 'not-an-object', 'intervalsOverlap');
  if (!Number.isFinite(left.timelineMs) || !Number.isFinite(right.timelineMs)) return true;
  const leftU = Number.isFinite(left.uncertaintyMs) ? left.uncertaintyMs : 0;
  const rightU = Number.isFinite(right.uncertaintyMs) ? right.uncertaintyMs : 0;
  return Math.abs(left.timelineMs - right.timelineMs) <= leftU + rightU;
}

/** 只按时间区间给顺序；重叠/缺时间 → 'indeterminate'（需独立显式顺序证据）。 */
export function resolveOrder(left, right) {
  if (!Number.isFinite(left?.timelineMs) || !Number.isFinite(right?.timelineMs)) return 'indeterminate';
  if (intervalsOverlap(left, right)) return 'indeterminate';
  return left.timelineMs < right.timelineMs ? 'before' : 'after';
}

/**
 * 事件时间的七分列投影（契约 §2.1/§2.2）。
 * - sourceTimestamp 是 CDP epoch 秒；只有提供锚点（offsetMs 把 source ms → Host mono）才得到
 *   `timelineMs`，否则 timelineMs 保持 null 并标 clock-uncertain。
 * - 源时间缺失时可用 receivedMonoMs 得到**接收轴** timeline，但 sourceTimestamp 仍是 null。
 */
export function buildEventTime(input = {}) {
  if (!isPlainObject(input)) badArgument('time', 'not-an-object', 'buildEventTime');
  assertAllowedKeys(input, [
    'sourceTimestamp', 'sourceClock', 'receivedMonoMs', 'wallMs', 'logicalMs',
    'anchor', 'originMonoMs', 'previousSourceTimestamp',
  ], 'buildEventTime');
  const sourceTimestamp = readNullableNumber(input, 'sourceTimestamp', 'buildEventTime');
  const receivedMonoMs = readNullableNumber(input, 'receivedMonoMs', 'buildEventTime');
  const wallMs = readNullableNumber(input, 'wallMs', 'buildEventTime');
  const logicalMs = readNullableNumber(input, 'logicalMs', 'buildEventTime');
  const originMonoMs = readNullableNumber(input, 'originMonoMs', 'buildEventTime');
  const previousSourceTimestamp = readNullableNumber(input, 'previousSourceTimestamp', 'buildEventTime');
  const sourceClock = readNullableString(input, 'sourceClock', 'buildEventTime', { maxBytes: 64 });
  const anchor = input.anchor === undefined || input.anchor === null ? null : input.anchor;
  if (anchor !== null && !isPlainObject(anchor)) badArgument('anchor', 'not-an-object', 'buildEventTime');

  const limitations = [];
  const classifications = [];
  let sourceMs = null;
  let mappedMonoMs = null;
  let clockUncertain = false;
  if (sourceTimestamp !== null) {
    sourceMs = sourceTimestamp * 1000;
    if (Number.isFinite(anchor?.offsetMs)) mappedMonoMs = sourceMs + anchor.offsetMs;
    else {
      clockUncertain = true;
      classifications.push('clock-uncertain');
      limitations.push('missing-clock-anchor');
    }
    if (previousSourceTimestamp !== null && sourceTimestamp < previousSourceTimestamp) {
      clockUncertain = true;
      if (!classifications.includes('clock-uncertain')) classifications.push('clock-uncertain');
      limitations.push('source-time-regressed');
    }
  }
  if (mappedMonoMs !== null && isClockUncertain(anchor)) {
    clockUncertain = true;
    if (!classifications.includes('clock-uncertain')) classifications.push('clock-uncertain');
    limitations.push('clock-uncertainty-exceeds-10ms');
  }

  let timelineMs = null;
  let timelineSource = 'none';
  if (mappedMonoMs !== null) {
    timelineMs = originMonoMs === null ? mappedMonoMs : mappedMonoMs - originMonoMs;
    timelineSource = 'source';
  } else if (receivedMonoMs !== null) {
    timelineMs = originMonoMs === null ? receivedMonoMs : receivedMonoMs - originMonoMs;
    timelineSource = 'received';
    if (sourceTimestamp === null) limitations.push('source-time-missing');
  }

  return {
    timelineMs,
    sourceTimestamp,
    sourceClock,
    receivedMonoMs,
    wallMs,
    logicalMs,
    anchorId: anchor?.anchorId ?? null,
    uncertaintyMs: Number.isFinite(anchor?.uncertaintyMs) ? anchor.uncertaintyMs : null,
    resolutionMs: Number.isFinite(anchor?.resolutionMs) ? anchor.resolutionMs : null,
    timelineSource,
    clockUncertain,
    classifications,
    limitations,
  };
}

/* ------------------------------------------------------------------ */
/* 事件信封 DynamicEventV1                                             */
/* ------------------------------------------------------------------ */

function normalizeTs(input) {
  if (input === undefined || input === null) {
    return {
      timelineMs: null,
      sourceTimestamp: null,
      sourceClock: null,
      receivedMonoMs: null,
      wallMs: null,
      logicalMs: null,
      anchorId: null,
      uncertaintyMs: null,
      resolutionMs: null,
    };
  }
  if (!isPlainObject(input)) badArgument('ts', 'not-an-object', 'event');
  assertAllowedKeys(input, [
    'timelineMs', 'sourceTimestamp', 'sourceClock', 'receivedMonoMs', 'wallMs', 'logicalMs',
    'anchorId', 'uncertaintyMs', 'resolutionMs',
  ], 'event.ts');
  return {
    timelineMs: readNullableNumber(input, 'timelineMs', 'event.ts'),
    sourceTimestamp: readNullableNumber(input, 'sourceTimestamp', 'event.ts'),
    sourceClock: readNullableString(input, 'sourceClock', 'event.ts', { maxBytes: 64 }),
    receivedMonoMs: readNullableNumber(input, 'receivedMonoMs', 'event.ts'),
    wallMs: readNullableNumber(input, 'wallMs', 'event.ts'),
    logicalMs: readNullableNumber(input, 'logicalMs', 'event.ts'),
    anchorId: readNullableString(input, 'anchorId', 'event.ts', { maxBytes: 128 }),
    uncertaintyMs: readNullableNumber(input, 'uncertaintyMs', 'event.ts', { min: 0 }),
    resolutionMs: readNullableNumber(input, 'resolutionMs', 'event.ts', { min: 0 }),
  };
}

function normalizeRequestKey(input, label) {
  if (input === undefined || input === null) return null;
  if (!isPlainObject(input)) badArgument('requestKey', 'not-an-object', label);
  assertAllowedKeys(input, ['networkSessionId', 'targetId', 'cdpSessionId', 'requestId', 'hopId'], label);
  const requestId = readString(input, 'requestId', label, { required: true, maxBytes: 256 });
  return {
    networkSessionId: readNullableString(input, 'networkSessionId', label, { maxBytes: 128 }),
    targetId: readNullableString(input, 'targetId', label, { maxBytes: 128 }),
    cdpSessionId: readNullableString(input, 'cdpSessionId', label, { maxBytes: 128 }),
    requestId,
    hopId: readNumber(input, 'hopId', label, { min: 0, integer: true, fallback: 0 }),
  };
}

function normalizeIds(input) {
  if (input === undefined || input === null) {
    return {
      actionId: null, opId: null, frameId: null, traceIdHash: null, requestKey: null,
    };
  }
  if (!isPlainObject(input)) badArgument('ids', 'not-an-object', 'event');
  assertAllowedKeys(input, ['actionId', 'opId', 'frameId', 'traceIdHash', 'requestKey'], 'event.ids');
  return {
    actionId: readNullableString(input, 'actionId', 'event.ids', { maxBytes: 128 }),
    opId: readNullableString(input, 'opId', 'event.ids', { maxBytes: 128 }),
    frameId: readNullableString(input, 'frameId', 'event.ids', { maxBytes: 128 }),
    traceIdHash: readNullableString(input, 'traceIdHash', 'event.ids', { maxBytes: 128 }),
    requestKey: normalizeRequestKey(input.requestKey, 'event.ids.requestKey'),
  };
}

function normalizeSourceRef(input) {
  if (input === undefined || input === null) {
    return {
      networkSessionId: null, networkSeq: null, visualSessionId: null, frameSeq: null,
    };
  }
  if (!isPlainObject(input)) badArgument('sourceRef', 'not-an-object', 'event');
  assertAllowedKeys(input, ['networkSessionId', 'networkSeq', 'visualSessionId', 'frameSeq'], 'event.sourceRef');
  return {
    networkSessionId: readNullableString(input, 'networkSessionId', 'event.sourceRef', { maxBytes: 128 }),
    networkSeq: readNullableNumber(input, 'networkSeq', 'event.sourceRef', { min: 0, integer: true }),
    visualSessionId: readNullableString(input, 'visualSessionId', 'event.sourceRef', { maxBytes: 128 }),
    frameSeq: readNullableNumber(input, 'frameSeq', 'event.sourceRef', { min: 0, integer: true }),
  };
}

function normalizeProvenance(input) {
  if (input === undefined || input === null) {
    return {
      producer: 'unknown', sourceKind: 'unknown', adapterId: null, adapterVersion: null,
      trust: 'caller-declared', evidenceIds: [], rawHash: null,
    };
  }
  if (!isPlainObject(input)) badArgument('provenance', 'not-an-object', 'event');
  assertAllowedKeys(input, [
    'producer', 'sourceKind', 'adapterId', 'adapterVersion', 'trust', 'evidenceIds', 'rawHash',
  ], 'event.provenance');
  const trust = readString(input, 'trust', 'event.provenance', { required: true, maxBytes: 64 });
  if (!TRUST_VALUES.includes(trust)) badArgument('trust', 'invalid-enum', 'event.provenance');
  const evidenceIds = input.evidenceIds === undefined ? [] : input.evidenceIds;
  if (!Array.isArray(evidenceIds)) badArgument('evidenceIds', 'not-an-array', 'event.provenance');
  if (evidenceIds.length > 200) badArgument('evidenceIds', 'too-many-items', 'event.provenance');
  for (const id of evidenceIds) {
    if (typeof id !== 'string' || id.length === 0) badArgument('evidenceIds', 'invalid-id', 'event.provenance');
  }
  return {
    producer: readString(input, 'producer', 'event.provenance', { required: true, maxBytes: 128 }),
    sourceKind: readString(input, 'sourceKind', 'event.provenance', { required: true, maxBytes: 64 }),
    adapterId: readNullableString(input, 'adapterId', 'event.provenance', { maxBytes: 128 }),
    adapterVersion: readNullableString(input, 'adapterVersion', 'event.provenance', { maxBytes: 64 }),
    trust,
    evidenceIds: [...new Set(evidenceIds)],
    rawHash: readNullableString(input, 'rawHash', 'event.provenance', { maxBytes: 128 }),
  };
}

/**
 * 规范化 DynamicEventV1：未知字段拒绝、缺失值一律 null（不使用默认值伪装观测）。
 * `ctx` 由 Host/日志提供：dynamicSessionId/scopeId/seq/eventId/now。
 */
export function normalizeDynamicEvent(input, ctx = {}) {
  if (!isPlainObject(input)) badArgument('event', 'not-an-object', 'event');
  assertAllowedKeys(input, [
    'version', 'eventId', 'dynamicSessionId', 'seq', 'domain', 'kind', 'phase',
    'scopeId', 'runtimeId', 'pageGeneration', 'documentEpoch', 'runGeneration',
    'targetId', 'cdpSessionId', 'documentFrameId', 'ts', 'ids', 'sourceRef',
    'provenance', 'payload', 'incomplete', 'truncated',
  ], 'event');

  const version = readNumber(input, 'version', 'event', { fallback: T4_VERSION });
  if (version !== T4_VERSION) badArgument('version', 'unsupported-version', 'event');

  const domain = input.domain;
  if (!DOMAIN_VALUES.includes(domain)) {
    badArgument('domain', hasOwn(input, 'domain') ? 'invalid-enum' : 'missing-required-field', 'event');
  }
  const kind = readString(input, 'kind', 'event', { required: true, maxBytes: 128 });
  const phase = readNullableString(input, 'phase', 'event', { maxBytes: 64 });

  let seq = null;
  if (hasOwn(input, 'seq') && input.seq !== null && input.seq !== undefined) {
    seq = readNumber(input, 'seq', 'event', { min: 0, integer: true, required: true });
  }
  if (Number.isInteger(ctx.seq)) {
    if (seq !== null && seq !== ctx.seq) badArgument('seq', 'non-monotonic', 'event');
    seq = ctx.seq;
  }

  let dynamicSessionId = readNullableString(input, 'dynamicSessionId', 'event', { maxBytes: 128 })
    ?? (typeof ctx.dynamicSessionId === 'string' ? ctx.dynamicSessionId : null);
  if (typeof ctx.dynamicSessionId === 'string'
    && dynamicSessionId !== null && dynamicSessionId !== ctx.dynamicSessionId) {
    badArgument('dynamicSessionId', 'session-mismatch', 'event');
  }
  if (dynamicSessionId === null && typeof ctx.dynamicSessionId === 'string') {
    dynamicSessionId = ctx.dynamicSessionId;
  }

  const ts = normalizeTs(input.ts);
  if (ts.receivedMonoMs === null && typeof ctx.now === 'function') ts.receivedMonoMs = ctx.now();

  const payload = input.payload === undefined || input.payload === null ? {} : input.payload;
  if (!isPlainObject(payload)) badArgument('payload', 'not-an-object', 'event');
  assertLossless(payload, 'event.payload');
  const incomplete = input.incomplete === undefined ? [] : input.incomplete;
  if (!Array.isArray(incomplete)) badArgument('incomplete', 'not-an-array', 'event');
  if (incomplete.length > 64) badArgument('incomplete', 'too-many-items', 'event');
  for (const item of incomplete) {
    if (typeof item !== 'string' || item.length === 0) badArgument('incomplete', 'invalid-item', 'event');
  }

  const eventId = readNullableString(input, 'eventId', 'event', { maxBytes: 128 })
    ?? (typeof ctx.eventId === 'string' ? ctx.eventId : randomId('ev'));

  const documentEpoch = input.documentEpoch === undefined || input.documentEpoch === null
    ? null
    : (typeof input.documentEpoch === 'string' || (typeof input.documentEpoch === 'number' && Number.isFinite(input.documentEpoch))
      ? input.documentEpoch
      : badArgument('documentEpoch', 'invalid-type', 'event'));

  return {
    version: T4_VERSION,
    eventId,
    dynamicSessionId,
    seq,
    domain,
    kind,
    phase,
    scopeId: readNullableString(input, 'scopeId', 'event', { maxBytes: 128 })
      ?? (typeof ctx.scopeId === 'string' ? ctx.scopeId : null),
    runtimeId: readNullableString(input, 'runtimeId', 'event', { maxBytes: 128 }),
    pageGeneration: readNullableNumber(input, 'pageGeneration', 'event', { min: 0, integer: true }),
    documentEpoch,
    runGeneration: readNullableNumber(input, 'runGeneration', 'event', { min: 0, integer: true }),
    targetId: readNullableString(input, 'targetId', 'event', { maxBytes: 128 }),
    cdpSessionId: readNullableString(input, 'cdpSessionId', 'event', { maxBytes: 128 }),
    documentFrameId: readNullableString(input, 'documentFrameId', 'event', { maxBytes: 128 }),
    ts,
    ids: normalizeIds(input.ids),
    sourceRef: normalizeSourceRef(input.sourceRef),
    provenance: normalizeProvenance(input.provenance),
    payload: cloneJson(payload),
    incomplete: [...new Set(incomplete)],
    truncated: readBoolean(input, 'truncated', 'event', false),
  };
}

/* ------------------------------------------------------------------ */
/* 有界事件日志 / 时间轴                                               */
/* ------------------------------------------------------------------ */

function emptyIntegrity(overrides = {}) {
  return {
    complete: true,
    captured: 0,
    retained: 0,
    dropped: 0,
    evicted: 0,
    truncated: false,
    ackFailures: 0,
    gaps: [],
    issues: [],
    coverage: {
      source: {},
      segments: [],
      maxAdjacentIntervalMs: null,
      missingSourceTimestamps: 0,
      samplingFailures: 0,
      decodeFailures: 0,
      adapters: [],
      unknownSourceDrops: null,
    },
    ...overrides,
  };
}

/** 有界动态事件日志：seq 会话内单调、5000/20000 上限、稳定时间轴排序。 */
export class DynamicEventLog {
  constructor({ scopeId = null, dynamicSessionId = null, now = () => Date.now(), limits = {} } = {}) {
    this.scopeId = scopeId;
    this.dynamicSessionId = dynamicSessionId;
    this._now = typeof now === 'function' ? now : () => Date.now();
    const maxEvents = limits.maxEvents === undefined ? T4_LIMITS.maxEvents : limits.maxEvents;
    if (!Number.isInteger(maxEvents) || maxEvents < 1) badArgument('maxEvents', 'not-a-positive-integer', 'limits');
    if (maxEvents > T4_LIMITS.maxEventsHard) {
      throw new BrowserError('DYNAMIC_LIMIT_EXCEEDED', 'maxEvents exceeds hard limit', {
        limit: 'maxEvents', value: maxEvents, hard: T4_LIMITS.maxEventsHard,
      });
    }
    this.maxEvents = maxEvents;
    this._events = [];
    this._byId = new Map();
    this._bySeq = new Map();
    this._highWater = 0;
    this._captured = 0;
    this._dropped = 0;
    this._evicted = 0;
    this._gaps = [];
    this._issues = [];
  }

  get size() {
    return this._events.length;
  }

  get highWater() {
    return this._highWater;
  }

  append(input) {
    const seq = this._highWater + 1;
    const event = normalizeDynamicEvent(input, {
      dynamicSessionId: this.dynamicSessionId,
      scopeId: this.scopeId,
      now: this._now,
      seq,
    });
    if (this.dynamicSessionId !== null && event.dynamicSessionId !== this.dynamicSessionId) {
      badArgument('dynamicSessionId', 'session-mismatch', 'event');
    }
    if (this._byId.has(event.eventId)) badArgument('eventId', 'duplicate-id', 'event');
    if (event.seq !== seq) badArgument('seq', 'non-monotonic', 'event');
    this._events.push(event);
    this._byId.set(event.eventId, event);
    this._bySeq.set(event.seq, event);
    this._highWater = seq;
    this._captured += 1;
    this._evictOverflow();
    return event;
  }

  _evictOverflow() {
    while (this._events.length > this.maxEvents) {
      const oldest = this._events.shift();
      this._byId.delete(oldest.eventId);
      this._bySeq.delete(oldest.seq);
      this._evicted += 1;
      const lastGap = this._gaps[this._gaps.length - 1];
      if (lastGap && lastGap.toSeq + 1 === oldest.seq) lastGap.toSeq = oldest.seq;
      else this._gaps.push({ fromSeq: oldest.seq, toSeq: oldest.seq });
    }
  }

  get(eventId) {
    if (typeof eventId !== 'string' || eventId.length === 0) badArgument('eventId', 'not-a-string', 'get');
    const event = this._byId.get(eventId);
    if (!event) throw notFound('event', eventId);
    return event;
  }

  bySeq(seq) {
    if (!Number.isInteger(seq) || seq < 0) badArgument('seq', 'not-a-non-negative-integer', 'bySeq');
    const event = this._bySeq.get(seq);
    if (!event) throw notFound('event', String(seq));
    return event;
  }

  /**
   * 按 seq 增量读取（含且仅含 seq > sinceSeq 的事件，最多 `limit` 条）。
   * 供 P0 订阅/增量投影使用；不改变事件本身。
   */
  sinceSeq(seq, limit = 50) {
    if (!Number.isInteger(seq) || seq < 0) badArgument('seq', 'not-a-non-negative-integer', 'sinceSeq');
    if (!Number.isInteger(limit) || limit < 1 || limit > 200) {
      badArgument('limit', 'not-in-range[1,200]', 'sinceSeq');
    }
    const events = [];
    for (const event of this._events) {
      if (event.seq === null || event.seq <= seq) continue;
      events.push(event);
      if (events.length >= limit) break;
    }
    return events;
  }

  query(options = {}) {
    if (!isPlainObject(options)) badArgument('query', 'not-an-object', 'query');
    assertAllowedKeys(options, [
      'sinceSeq', 'untilSeq', 'fromMs', 'toMs', 'domains', 'kinds', 'limit', 'cursor',
    ], 'query');
    const limit = readNumber(options, 'limit', 'query', { min: 1, max: 200, integer: true, fallback: 50 });
    const sinceSeq = readNullableNumber(options, 'sinceSeq', 'query', { min: 0, integer: true });
    const untilSeq = readNullableNumber(options, 'untilSeq', 'query', { min: 0, integer: true });
    const fromMs = readNullableNumber(options, 'fromMs', 'query');
    const toMs = readNullableNumber(options, 'toMs', 'query');
    if (fromMs !== null && toMs !== null && fromMs > toMs) badArgument('window', 'from-greater-than-to', 'query');
    const cursor = options.cursor === undefined || options.cursor === null ? null : decodeCursor(options.cursor, 'query.cursor');
    if (cursor && sinceSeq !== null) badArgument('cursor', 'cursor-and-sinceSeq-exclusive', 'query');
    if (cursor && (!Number.isInteger(cursor.s) || cursor.s < 0)) badArgument('cursor', 'invalid-cursor', 'query');
    if (sinceSeq !== null && untilSeq !== null && sinceSeq > untilSeq) {
      badArgument('sinceSeq', 'greater-than-untilSeq', 'query');
    }
    let domains = null;
    if (options.domains !== undefined && options.domains !== null) {
      if (!Array.isArray(options.domains)) badArgument('domains', 'not-an-array', 'query');
      for (const domain of options.domains) {
        if (!DOMAIN_VALUES.includes(domain)) badArgument('domains', 'invalid-enum', 'query');
      }
      domains = new Set(options.domains);
    }
    let kinds = null;
    if (options.kinds !== undefined && options.kinds !== null) {
      if (!Array.isArray(options.kinds)) badArgument('kinds', 'not-an-array', 'query');
      if (options.kinds.length > 50) badArgument('kinds', 'too-many-items', 'query');
      kinds = new Set(options.kinds);
    }
    const minSeq = sinceSeq !== null ? sinceSeq : (cursor ? cursor.s : -1);
    const selected = [];
    for (const event of this._events) {
      if (event.seq === null || event.seq <= minSeq) continue;
      if (untilSeq !== null && event.seq > untilSeq) continue;
      if (domains && !domains.has(event.domain)) continue;
      if (kinds && !kinds.has(event.kind)) continue;
      const time = event.ts.timelineMs;
      if (fromMs !== null || toMs !== null) {
        if (time === null) continue;
        if (fromMs !== null && time < fromMs) continue;
        if (toMs !== null && time > toMs) continue;
      }
      selected.push(event);
      if (selected.length > limit) break;
    }
    const truncated = selected.length > limit;
    const events = selected.slice(0, limit);
    const last = events.length > 0 ? events[events.length - 1] : null;
    return {
      events,
      fromSeq: events.length > 0 ? events[0].seq : null,
      toSeq: last ? last.seq : null,
      highWater: this._highWater,
      truncated,
      cursor: { next: truncated && last ? encodeCursor({ s: last.seq }) : null },
    };
  }

  timeline(options = {}) {
    const result = this.query({ ...options, limit: 200 });
    return sortTimeline(result.events);
  }

  integrity() {
    const sourceClocks = new Set();
    let missingSourceTimestamps = 0;
    let maxGapMs = null;
    let previous = null;
    for (const event of sortTimeline(this._events)) {
      if (event.ts.sourceClock !== null) sourceClocks.add(event.ts.sourceClock);
      if (event.ts.sourceTimestamp === null) missingSourceTimestamps += 1;
      const time = event.ts.timelineMs;
      if (time !== null && previous !== null) {
        const gap = time - previous;
        if (maxGapMs === null || gap > maxGapMs) maxGapMs = gap;
      }
      if (time !== null) previous = time;
    }
    const domains = [...new Set(this._events.map((event) => event.domain))].sort();
    const complete = this._dropped === 0 && this._evicted === 0 && this._gaps.length === 0 && this._issues.length === 0;
    return emptyIntegrity({
      complete,
      captured: this._captured,
      retained: this._events.length,
      dropped: this._dropped,
      evicted: this._evicted,
      gaps: this._gaps.map((gap) => ({ ...gap })),
      issues: this._issues.map((issue) => ({ ...issue })),
      coverage: {
        source: { domains, sourceClocks: [...sourceClocks].sort() },
        segments: this._events.length > 0
          ? [{ fromSeq: this._events[0].seq, toSeq: this._events[this._events.length - 1].seq }]
          : [],
        maxAdjacentIntervalMs: maxGapMs,
        missingSourceTimestamps,
        samplingFailures: 0,
        decodeFailures: 0,
        adapters: [],
        unknownSourceDrops: null,
      },
    });
  }

  dispose() {
    this._events = [];
    this._byId.clear();
    this._bySeq.clear();
  }
}

/* ------------------------------------------------------------------ */
/* 有界帧存储                                                          */
/* ------------------------------------------------------------------ */

function validateImage(image, label = 'image') {
  if (!isPlainObject(image)) badArgument(label, 'not-an-object', label);
  assertAllowedKeys(image, ['width', 'height', 'rgba'], label);
  const width = readNumber(image, 'width', label, { min: 1, integer: true, required: true });
  const height = readNumber(image, 'height', label, { min: 1, integer: true, required: true });
  const rgba = image.rgba;
  if (!(rgba instanceof Uint8Array) && !(rgba instanceof Uint8ClampedArray)) {
    badArgument(`${label}.rgba`, 'not-a-byte-array', label);
  }
  if (rgba.length !== width * height * 4) badArgument(`${label}.rgba`, 'length-mismatch', label);
  // vision-t3 的 diffImages/findInImage 要求 Uint8Array；Uint8ClampedArray 是独立类型，
  // 这里用零拷贝视图统一，避免 JPEG 解码结果（Uint8ClampedArray）在分析入口被拒。
  const analysisRgba = rgba instanceof Uint8Array
    ? rgba
    : new Uint8Array(rgba.buffer, rgba.byteOffset, rgba.byteLength);
  return { width, height, rgba: analysisRgba };
}

function normalizeDimensions(input, label = 'frame') {
  let width;
  let height;
  if (input.dimensions !== undefined && input.dimensions !== null) {
    if (!isPlainObject(input.dimensions)) badArgument('dimensions', 'not-an-object', label);
    assertAllowedKeys(input.dimensions, ['width', 'height'], `${label}.dimensions`);
    width = readNumber(input.dimensions, 'width', `${label}.dimensions`, { min: 1, integer: true, required: true });
    height = readNumber(input.dimensions, 'height', `${label}.dimensions`, { min: 1, integer: true, required: true });
  } else {
    width = readNumber(input, 'width', label, { min: 1, integer: true, required: true });
    height = readNumber(input, 'height', label, { min: 1, integer: true, required: true });
  }
  return { width, height };
}

function normalizeMapping(mapping, label) {
  if (mapping === undefined || mapping === null) return null;
  if (!isPlainObject(mapping)) badArgument('mapping', 'not-an-object', label);
  assertLossless(mapping, `${label}.mapping`);
  return cloneJson(mapping);
}

function normalizeProvenanceRecord(provenance, label) {
  if (provenance === undefined || provenance === null) {
    return {
      producer: 'unknown', sourceKind: 'unknown', adapterId: null, adapterVersion: null,
      trust: 'caller-declared', evidenceIds: [], rawHash: null,
    };
  }
  return normalizeProvenance(provenance);
}

function normalizeDecodeRecord(decode, label) {
  if (decode === undefined || decode === null) {
    return { failed: false, code: null, decoder: null, decoderProvenance: null };
  }
  if (!isPlainObject(decode)) badArgument('decode', 'not-an-object', label);
  assertAllowedKeys(decode, ['failed', 'code', 'decoder', 'decoderProvenance'], `${label}.decode`);
  const provenance = decode.decoderProvenance;
  if (provenance !== undefined && provenance !== null) {
    if (!isPlainObject(provenance)) badArgument('decoderProvenance', 'not-an-object', `${label}.decode`);
    assertAllowedKeys(provenance, ['kind', 'version'], `${label}.decode.decoderProvenance`);
  }
  return {
    failed: readBoolean(decode, 'failed', `${label}.decode`, false),
    code: readNullableString(decode, 'code', `${label}.decode`, { maxBytes: 64 }),
    decoder: readNullableString(decode, 'decoder', `${label}.decode`, { maxBytes: 64 }),
    decoderProvenance: provenance
      ? {
        kind: readString(provenance, 'kind', `${label}.decode.decoderProvenance`, { required: true, maxBytes: 64 }),
        version: readNumber(provenance, 'version', `${label}.decode.decoderProvenance`, { required: true }),
      }
      : null,
  };
}

function normalizeAckRecord(ack, label) {
  if (ack === undefined || ack === null) return null;
  if (!isPlainObject(ack)) badArgument('ack', 'not-an-object', label);
  assertAllowedKeys(ack, ['attempted', 'ok'], `${label}.ack`);
  return {
    attempted: readNumber(ack, 'attempted', `${label}.ack`, { min: 0, integer: true, fallback: 0 }),
    ok: readBoolean(ack, 'ok', `${label}.ack`, false),
  };
}

/** 有界帧存储：帧数/编码字节双预算、pin 保护、淘汰/丢弃/ACK/缺口计数。 */
export class DynamicFrameStore {
  constructor({
    scopeId = null, dynamicSessionId = null, now = () => Date.now(), limits = {}, adapter = null,
  } = {}) {
    this.scopeId = scopeId;
    this.dynamicSessionId = dynamicSessionId;
    this._now = typeof now === 'function' ? now : () => Date.now();
    const maxFrames = limits.maxFrames === undefined ? T4_LIMITS.maxFrames : limits.maxFrames;
    const maxBytes = limits.maxBytes === undefined ? T4_LIMITS.maxBytes : limits.maxBytes;
    if (!Number.isInteger(maxFrames) || maxFrames < 1) badArgument('maxFrames', 'not-a-positive-integer', 'limits');
    if (maxFrames > T4_LIMITS.maxFramesHard) {
      throw new BrowserError('DYNAMIC_LIMIT_EXCEEDED', 'maxFrames exceeds hard limit', {
        limit: 'maxFrames', value: maxFrames, hard: T4_LIMITS.maxFramesHard,
      });
    }
    if (!Number.isInteger(maxBytes) || maxBytes < 1) badArgument('maxBytes', 'not-a-positive-integer', 'limits');
    if (maxBytes > T4_LIMITS.maxBytesHard) {
      throw new BrowserError('DYNAMIC_LIMIT_EXCEEDED', 'maxBytes exceeds hard limit', {
        limit: 'maxBytes', value: maxBytes, hard: T4_LIMITS.maxBytesHard,
      });
    }
    this.maxFrames = maxFrames;
    this.maxBytes = maxBytes;
    this._frames = new Map();
    this._totalBytes = 0;
    this._highWater = 0;
    this._captured = 0;
    this._dropped = 0;
    this._evicted = 0;
    this._ackFailures = 0;
    this._ackAttempts = 0;
    this._decodeFailures = 0;
    this._samplingFailures = 0;
    this._gaps = [];
    this._issues = [];
    this.adapter = adapter && isPlainObject(adapter) ? {
      id: readNullableString(adapter, 'id', 'adapter', { maxBytes: 128 }),
      available: readBoolean(adapter, 'available', 'adapter', false),
      version: readNullableString(adapter, 'version', 'adapter', { maxBytes: 64 }),
    } : null;
  }

  get size() {
    return this._frames.size;
  }

  get totalBytes() {
    return this._totalBytes;
  }

  get highWater() {
    return this._highWater;
  }

  get pinnedCount() {
    let count = 0;
    for (const frame of this._frames.values()) if (frame.pinned) count += 1;
    return count;
  }

  /**
   * 采集回调入口：永不因预算拒绝而抛错（计 dropped 并返回 ok:false，不阻塞 ACK）。
   * 参数/编码等纯输入问题仍抛 DYNAMIC_INVALID_ARGUMENT。
   */
  addFrame(input = {}) {
    if (!isPlainObject(input)) badArgument('frame', 'not-an-object', 'addFrame');
    assertAllowedKeys(input, [
      'frameId', 'frameSeq', 'seq', 'scopeId', 'dynamicSessionId', 'sourceTimestamp', 'sourceTimestampUnit',
      'sourceClock', 'receivedMonoMs', 'timelineMs', 'encoding', 'bytes', 'encodedBytes', 'sha256',
      'encodedSha256', 'rgbaSha256', 'dimensions', 'width', 'height', 'mapping', 'provenance',
      'documentEpoch', 'runGeneration', 'segmentId', 'image', 'ack', 'incomplete', 'pinned', 'decode',
    ], 'addFrame');

    const dimensions = normalizeDimensions(input, 'addFrame');
    const pixels = dimensions.width * dimensions.height;
    if (pixels > T4_LIMITS.maxFramePixels) {
      this._dropped += 1;
      this._issue({ code: 'frame-pixels-exceeded', pixels, limit: T4_LIMITS.maxFramePixels });
      return {
        ok: false, frameId: null, seq: null, evicted: [], reason: 'pixels',
      };
    }
    const bytes = input.bytes ?? input.encodedBytes;
    if (!(bytes instanceof Uint8Array) && !Buffer.isBuffer(bytes)) {
      badArgument('bytes', 'not-a-byte-array', 'addFrame');
    }
    if (bytes.length > T4_LIMITS.maxFrameBytes) {
      this._dropped += 1;
      this._issue({ code: 'frame-bytes-exceeded', bytes: bytes.length, limit: T4_LIMITS.maxFrameBytes });
      return {
        ok: false, frameId: null, seq: null, evicted: [], reason: 'oversize',
      };
    }
    const encoding = input.encoding === undefined ? 'png' : input.encoding;
    if (encoding !== 'png' && encoding !== 'jpeg') badArgument('encoding', 'invalid-enum', 'addFrame');
    let image = null;
    if (input.image !== undefined && input.image !== null) {
      image = validateImage(input.image, 'addFrame.image');
      if (image.width !== dimensions.width || image.height !== dimensions.height) {
        badArgument('image', 'dimensions-mismatch', 'addFrame');
      }
    }
    const sourceTimestamp = readNullableNumber(input, 'sourceTimestamp', 'addFrame', { min: 0 });
    const receivedMonoMs = readNullableNumber(input, 'receivedMonoMs', 'addFrame', { min: 0 })
      ?? this._now();
    const timelineMs = readNullableNumber(input, 'timelineMs', 'addFrame');
    const explicitFrameId = readNullableString(input, 'frameId', 'addFrame', { maxBytes: 128 });
    if (explicitFrameId !== null && this._frames.has(explicitFrameId)) badArgument('frameId', 'duplicate-id', 'addFrame');
    const frameId = explicitFrameId ?? randomId('fr');
    const seq = this._highWater + 1;

    const evicted = [];
    while (this._frames.size + 1 > this.maxFrames || this._totalBytes + bytes.length > this.maxBytes) {
      const victim = this._evictOldestUnpinned();
      if (victim === null) {
        this._dropped += 1;
        this._issue({ code: 'frame-queue-full', frames: this._frames.size, maxFrames: this.maxFrames });
        return {
          ok: false, frameId: null, seq: null, evicted: [], reason: 'queue-full',
        };
      }
      evicted.push(victim);
    }

    const encodedSha256 = readNullableString(input, 'encodedSha256', 'addFrame', { maxBytes: 128 })
      ?? readNullableString(input, 'sha256', 'addFrame', { maxBytes: 128 })
      ?? sha256Hex(bytes);
    const rgbaSha256 = readNullableString(input, 'rgbaSha256', 'addFrame', { maxBytes: 128 })
      ?? (image ? sha256Hex(Buffer.from(image.rgba.buffer, image.rgba.byteOffset, image.rgba.byteLength)) : null);

    const record = {
      frameId,
      seq,
      scopeId: readNullableString(input, 'scopeId', 'addFrame', { maxBytes: 128 }) ?? this.scopeId,
      dynamicSessionId: readNullableString(input, 'dynamicSessionId', 'addFrame', { maxBytes: 128 })
        ?? this.dynamicSessionId,
      sourceTimestamp,
      sourceClock: readNullableString(input, 'sourceClock', 'addFrame', { maxBytes: 64 }) ?? 'cdp-screencast',
      receivedMonoMs,
      timelineMs,
      encoding,
      bytesLength: bytes.length,
      sha256: encodedSha256,
      encodedSha256,
      rgbaSha256,
      dimensions,
      mapping: normalizeMapping(input.mapping, 'addFrame'),
      documentEpoch: input.documentEpoch === undefined || input.documentEpoch === null
        ? null
        : (typeof input.documentEpoch === 'string'
          || (Number.isFinite(input.documentEpoch) && input.documentEpoch !== null)
          ? input.documentEpoch
          : badArgument('documentEpoch', 'invalid-type', 'addFrame')),
      runGeneration: readNullableNumber(input, 'runGeneration', 'addFrame', { min: 0, integer: true }),
      segmentId: readNullableString(input, 'segmentId', 'addFrame', { maxBytes: 128 }) ?? 'default',
      provenance: normalizeProvenanceRecord(input.provenance, 'addFrame'),
      ack: normalizeAckRecord(input.ack, 'addFrame'),
      pinned: input.pinned === true,
      incomplete: Array.isArray(input.incomplete) ? [...new Set(input.incomplete)] : [],
      decode: normalizeDecodeRecord(input.decode, 'addFrame'),
      image,
      bytes,
    };
    if (record.scopeId !== null && this.scopeId !== null && record.scopeId !== this.scopeId) {
      throw notFound('frame', frameId);
    }
    if (record.dynamicSessionId !== null && this.dynamicSessionId !== null
      && record.dynamicSessionId !== this.dynamicSessionId) {
      throw notFound('frame', frameId);
    }

    this._frames.set(frameId, record);
    this._totalBytes += bytes.length;
    this._highWater = seq;
    this._captured += 1;
    if (record.ack && record.ack.attempted > 0) {
      this._ackAttempts += record.ack.attempted;
      if (!record.ack.ok) this._ackFailures += 1;
    }
    return {
      ok: true, frameId, seq, evicted, reason: null,
    };
  }

  _issue(issue) {
    this._issues.push({ ...issue, atMonoMs: this._now() });
    if (this._issues.length > 200) this._issues.shift();
  }

  _evictOldestUnpinned() {
    for (const [frameId, frame] of this._frames) {
      if (frame.pinned) continue;
      this._deleteFrame(frameId);
      this._evicted += 1;
      this._pushGap({ fromSeq: frame.seq, toSeq: frame.seq, reason: 'evicted' });
      return frameId;
    }
    return null;
  }

  _deleteFrame(frameId) {
    const frame = this._frames.get(frameId);
    if (!frame) return null;
    this._frames.delete(frameId);
    this._totalBytes -= frame.bytesLength;
    return frame;
  }

  pin(frameId) {
    const frame = this._lookup(frameId, 'pin');
    frame.pinned = true;
    return { frameId: frame.frameId, pinned: true };
  }

  unpin(frameId) {
    const frame = this._lookup(frameId, 'unpin');
    frame.pinned = false;
    return { frameId: frame.frameId, pinned: false };
  }

  _lookup(frameId, label) {
    if (typeof frameId !== 'string' || frameId.length === 0) badArgument('frameId', 'not-a-string', label);
    const frame = this._frames.get(frameId);
    if (!frame) throw notFound('frame', frameId);
    return frame;
  }

  getFrame(frameId) {
    return this._lookup(frameId, 'getFrame');
  }

  getFrameImage(frameId) {
    return this._lookup(frameId, 'getFrameImage').image;
  }

  /**
   * 有界查询：`frameIds` 与窗口/游标互斥；未知/已淘汰/跨会话 ID 同形 NOT_FOUND。
   */
  listFrames(options = {}) {
    if (!isPlainObject(options)) badArgument('options', 'not-an-object', 'listFrames');
    assertAllowedKeys(options, ['frameIds', 'sinceSeq', 'window', 'limit', 'cursor'], 'listFrames');
    const limit = readNumber(options, 'limit', 'listFrames', { min: 1, max: 200, integer: true, fallback: 50 });
    const frameIds = options.frameIds;
    const hasFrameIds = frameIds !== undefined && frameIds !== null;
    if (hasFrameIds) {
      if (!Array.isArray(frameIds)) badArgument('frameIds', 'not-an-array', 'listFrames');
      if (frameIds.length === 0) badArgument('frameIds', 'empty-array', 'listFrames');
      if (frameIds.length > 200) badArgument('frameIds', 'too-many-items', 'listFrames');
      if (options.window !== undefined && options.window !== null) {
        badArgument('frameIds', 'frameIds-and-window-exclusive', 'listFrames');
      }
      if (options.cursor !== undefined && options.cursor !== null) {
        badArgument('frameIds', 'frameIds-and-cursor-exclusive', 'listFrames');
      }
      if (options.sinceSeq !== undefined && options.sinceSeq !== null) {
        badArgument('frameIds', 'frameIds-and-sinceSeq-exclusive', 'listFrames');
      }
      const frames = frameIds.map((frameId) => this._lookup(frameId, 'listFrames'));
      return {
        frames,
        fromSeq: frames.length > 0 ? frames[0].seq : null,
        toSeq: frames.length > 0 ? frames[frames.length - 1].seq : null,
        highWater: this._highWater,
        truncated: frames.length > limit,
        cursor: { next: null },
      };
    }

    const sinceSeq = readNullableNumber(options, 'sinceSeq', 'listFrames', { min: 0, integer: true });
    const cursor = options.cursor === undefined || options.cursor === null
      ? null
      : decodeCursor(options.cursor, 'listFrames.cursor');
    if (cursor && sinceSeq !== null) badArgument('cursor', 'cursor-and-sinceSeq-exclusive', 'listFrames');
    if (cursor && (!Number.isInteger(cursor.s) || cursor.s < 0)) badArgument('cursor', 'invalid-cursor', 'listFrames');
    let window = null;
    if (options.window !== undefined && options.window !== null) {
      if (!isPlainObject(options.window)) badArgument('window', 'not-an-object', 'listFrames');
      assertAllowedKeys(options.window, ['fromMs', 'toMs'], 'listFrames.window');
      const fromMs = readNumber(options.window, 'fromMs', 'listFrames.window', { required: true });
      const toMs = readNumber(options.window, 'toMs', 'listFrames.window', { required: true });
      if (fromMs > toMs) badArgument('window', 'from-greater-than-to', 'listFrames');
      window = { fromMs, toMs };
    }
    const minSeq = sinceSeq !== null ? sinceSeq : (cursor ? cursor.s : -1);
    const selected = [];
    for (const frame of this._frames.values()) {
      if (frame.seq <= minSeq) continue;
      if (window !== null) {
        if (!Number.isFinite(frame.timelineMs)) continue;
        if (frame.timelineMs < window.fromMs || frame.timelineMs > window.toMs) continue;
      }
      selected.push(frame);
      if (selected.length > limit) break;
    }
    const truncated = selected.length > limit;
    const frames = selected.slice(0, limit);
    const last = frames.length > 0 ? frames[frames.length - 1] : null;
    return {
      frames,
      fromSeq: frames.length > 0 ? frames[0].seq : null,
      toSeq: last ? last.seq : null,
      highWater: this._highWater,
      truncated,
      cursor: { next: truncated && last ? encodeCursor({ s: last.seq }) : null },
    };
  }

  getFrames(options = {}) {
    return this.listFrames(options).frames;
  }

  recordAck(ok = true) {
    if (typeof ok !== 'boolean') badArgument('ok', 'not-a-boolean', 'recordAck');
    this._ackAttempts += 1;
    if (!ok) this._ackFailures += 1;
    return { attempted: this._ackAttempts, failures: this._ackFailures };
  }

  markDecodeFailure(reason = 'decode-failed') {
    this._decodeFailures += 1;
    this._issue({ code: 'decode-failure', reason: String(reason).slice(0, 128) });
  }

  markSamplingFailure() {
    this._samplingFailures += 1;
    return this._samplingFailures;
  }

  /** Host 侧显式缺口（screenshot-loop 错过 tick、页面对齐丢帧等）。 */
  markGap(input = {}) {
    if (!isPlainObject(input)) badArgument('gap', 'not-an-object', 'markGap');
    assertAllowedKeys(input, ['fromSeq', 'toSeq', 'reason'], 'markGap');
    const fromSeq = readNumber(input, 'fromSeq', 'markGap', { min: 0, integer: true, required: true });
    const toSeq = readNumber(input, 'toSeq', 'markGap', { min: fromSeq, integer: true, required: true });
    const reason = readNullableString(input, 'reason', 'markGap', { maxBytes: 128 });
    this._pushGap({ fromSeq, toSeq, reason });
    return { fromSeq, toSeq, reason };
  }

  _pushGap(gap) {
    const normalized = { fromSeq: gap.fromSeq, toSeq: gap.toSeq, reason: gap.reason ?? null };
    const last = this._gaps[this._gaps.length - 1];
    if (last && last.toSeq + 1 === normalized.fromSeq && (last.reason ?? null) === normalized.reason) {
      last.toSeq = normalized.toSeq;
      return;
    }
    this._gaps.push(normalized);
  }

  setAdapter(adapter) {
    if (!isPlainObject(adapter)) badArgument('adapter', 'not-an-object', 'setAdapter');
    this.adapter = {
      id: readNullableString(adapter, 'id', 'adapter', { maxBytes: 128 }),
      available: readBoolean(adapter, 'available', 'adapter', false),
      version: readNullableString(adapter, 'version', 'adapter', { maxBytes: 64 }),
    };
    return this.adapter;
  }

  /** 按 segmentId 聚合区段（帧 seq 连续、时间可缺）。 */
  _segments() {
    const groups = new Map();
    for (const frame of this._frames.values()) {
      const key = frame.segmentId;
      if (!groups.has(key)) groups.set(key, []);
      groups.get(key).push(frame);
    }
    const segments = [];
    for (const [segmentId, frames] of groups) {
      frames.sort((left, right) => left.seq - right.seq);
      segments.push({
        segmentId,
        fromSeq: frames[0].seq,
        toSeq: frames[frames.length - 1].seq,
        frames: frames.length,
        fromMs: frames.find((frame) => Number.isFinite(frame.timelineMs))?.timelineMs ?? null,
        toMs: [...frames].reverse().find((frame) => Number.isFinite(frame.timelineMs))?.timelineMs ?? null,
      });
    }
    segments.sort((left, right) => left.fromSeq - right.fromSeq);
    return segments;
  }

  integrity() {
    const frames = [...this._frames.values()].sort((left, right) => left.seq - right.seq);
    const encodings = new Set();
    const sourceClocks = new Set();
    const producers = new Set();
    let missingSourceTimestamps = 0;
    let maxGapMs = null;
    let previousTime = null;
    for (const frame of frames) {
      encodings.add(frame.encoding);
      if (frame.sourceClock !== null) sourceClocks.add(frame.sourceClock);
      producers.add(frame.provenance.producer);
      if (frame.sourceTimestamp === null) missingSourceTimestamps += 1;
      if (Number.isFinite(frame.timelineMs)) {
        if (previousTime !== null) {
          const gap = frame.timelineMs - previousTime;
          if (maxGapMs === null || gap > maxGapMs) maxGapMs = gap;
        }
        previousTime = frame.timelineMs;
      }
    }
    const complete = this._dropped === 0
      && this._evicted === 0
      && this._ackFailures === 0
      && this._decodeFailures === 0
      && this._samplingFailures === 0
      && this._gaps.length === 0
      && this._issues.length === 0;
    return emptyIntegrity({
      complete,
      captured: this._captured,
      retained: this._frames.size,
      dropped: this._dropped,
      evicted: this._evicted,
      ackFailures: this._ackFailures,
      gaps: this._gaps.map((gap) => ({ ...gap })),
      issues: this._issues.map((issue) => ({ ...issue })),
      coverage: {
        source: {
          encodings: [...encodings].sort(),
          sourceClocks: [...sourceClocks].sort(),
          producers: [...producers].sort(),
        },
        segments: this._segments(),
        maxAdjacentIntervalMs: maxGapMs,
        missingSourceTimestamps,
        samplingFailures: this._samplingFailures,
        decodeFailures: this._decodeFailures,
        adapters: this.adapter ? [{ ...this.adapter }] : [],
        unknownSourceDrops: null,
      },
    });
  }

  dispose() {
    this._frames.clear();
    this._totalBytes = 0;
  }
}

/* ------------------------------------------------------------------ */
/* 分析原语：公共输入/阈值/帧集合辅助                                  */
/* ------------------------------------------------------------------ */

const PRIMITIVE_INPUT_KEYS = Object.freeze([
  'frames', 'region', 'masks', 'thresholds', 'signal', 'budgetMs',
  'events', 'advancingEvidence', 'integrity', 'query', 'expectation',
  'expectedIntervalMs', 'intervalFactor', 'maxStep', 'templateImage', 'budget',
]);

const THRESHOLD_RANGES = Object.freeze({
  pixelThreshold: { min: 0, max: 1 },
  changeRatio: { min: 0, max: 1 },
  stableRatio: { min: 0, max: 1 },
  brightnessDelta: { min: 0, max: 255 },
  maxDurationMs: { min: 0, max: 10000 },
  minDurationMs: { min: 0, max: 10000 },
  minArea: { min: 1, max: 16000000, integer: true },
  stableSamples: { min: 2, max: 20, integer: true },
  intervalFactor: { min: 1, max: 10 },
  maxStep: { min: 1, max: 1000000 },
});

/* ------------------------------------------------------------------ */
/* 断言规格（机器可读，TOOL-P1-06）                                    */
/* 唯一真值来源：T4_THRESHOLDS（阈值 allowed/defaults）、THRESHOLD_RANGES、 */
/* 以及 validateMotionAssertions/validateTrajectoryQuery 实际执行的规则。   */
/* MOTION_ASSERTION_SCHEMA 与校验器都从下面的规则派生，不复制第二套字段表。 */
/* ------------------------------------------------------------------ */

const MOTION_ASSERTION_BASE_FIELDS = Object.freeze(['id', 'type', 'region', 'masks', 'thresholds']);
const MOTION_CONDITIONAL_FIELDS = Object.freeze(['expectedIntervalMs', 'query', 'expectation']);

/**
 * 每类断言的额外字段规则：
 *  - `required`：必须出现（缺失为 missing-required-field）；
 *  - `conditional`：该类型允许出现的额外字段（出现其它额外字段为 not-applicable-for-type）。
 * 校验器与 MOTION_ASSERTION_SCHEMA 共用这份表。
 */
const MOTION_TYPE_RULES = Object.freeze({
  'frame-diff': Object.freeze({ required: Object.freeze([]), conditional: Object.freeze([]) }),
  'region-change': Object.freeze({ required: Object.freeze([]), conditional: Object.freeze([]) }),
  flicker: Object.freeze({ required: Object.freeze([]), conditional: Object.freeze([]) }),
  freeze: Object.freeze({ required: Object.freeze(['expectation']), conditional: Object.freeze(['expectation']) }),
  jank: Object.freeze({
    required: Object.freeze(['expectedIntervalMs']),
    conditional: Object.freeze(['expectedIntervalMs']),
  }),
  trajectory: Object.freeze({ required: Object.freeze(['query']), conditional: Object.freeze(['query']) }),
  transition: Object.freeze({ required: Object.freeze([]), conditional: Object.freeze([]) }),
});

const MOTION_EXPECTATION_LIMITS = Object.freeze({
  maxEventIdBytes: 128,
  maxReferenceIds: 16,
});

/** trajectory.query 两个 variant 的字段边界/默认值（校验器与 schema 共用）。 */
const MOTION_QUERY_VARIANTS = Object.freeze({
  color: Object.freeze({
    method: 'color',
    required: Object.freeze(['method', 'color']),
    allowed: Object.freeze(['method', 'color', 'tolerance', 'minArea', 'maxResults']),
    fields: Object.freeze({
      color: Object.freeze({
        type: 'rgb', channels: 3, min: 0, max: 255, integer: true,
      }),
      tolerance: Object.freeze({
        type: 'number', min: 0, max: 255, integer: true, default: 16,
      }),
      minArea: Object.freeze({
        type: 'number', min: 1, max: 16000000, integer: true, default: 4,
      }),
      maxResults: Object.freeze({
        type: 'number', min: 1, max: 20, integer: true, default: 20,
      }),
    }),
  }),
  template: Object.freeze({
    method: 'template',
    required: Object.freeze(['method', 'productId']),
    allowed: Object.freeze(['method', 'productId', 'minScore', 'stride', 'maxResults']),
    fields: Object.freeze({
      productId: Object.freeze({
        type: 'string', pattern: '^v1_[0-9a-f]{32}$', maxBytes: 128,
      }),
      minScore: Object.freeze({
        type: 'number', min: 0, max: 1, default: 0.95,
      }),
      stride: Object.freeze({ type: 'number', min: 1, max: 16, integer: true, default: 1 }),
      maxResults: Object.freeze({ type: 'number', min: 1, max: 20, integer: true, default: 20 }),
    }),
  }),
});

const MOTION_PIXEL_RECT_SCHEMA = Object.freeze({
  type: 'object',
  additionalProperties: false,
  required: Object.freeze(['x', 'y', 'width', 'height']),
  properties: Object.freeze({
    x: Object.freeze({ type: 'integer', minimum: 0 }),
    y: Object.freeze({ type: 'integer', minimum: 0 }),
    width: Object.freeze({ type: 'integer', minimum: 1 }),
    height: Object.freeze({ type: 'integer', minimum: 1 }),
  }),
});

const MOTION_FIELD_SPECS = Object.freeze({
  id: Object.freeze({
    type: 'string', required: true, minBytes: 1, maxBytes: 64,
  }),
  type: Object.freeze({ type: 'enum', required: true, values: MOTION_TYPES }),
  region: Object.freeze({ type: 'object', nullable: false, schema: MOTION_PIXEL_RECT_SCHEMA }),
  masks: Object.freeze({
    type: 'array',
    maxItems: T4_LIMITS.maxMasks,
    items: Object.freeze({
      type: 'object',
      additionalProperties: false,
      required: Object.freeze(['id', 'region']),
      properties: Object.freeze({
        id: Object.freeze({ type: 'string', pattern: '^[a-zA-Z0-9][a-zA-Z0-9_-]{0,63}$' }),
        region: MOTION_PIXEL_RECT_SCHEMA,
      }),
    }),
  }),
  thresholds: Object.freeze({
    type: 'object',
    additionalProperties: false,
    valueType: 'finite-number',
    note: 'allowed keys/defaults are per-type (see byType[type].thresholds)',
  }),
  expectedIntervalMs: Object.freeze({
    type: 'number',
    exclusiveMinimum: 0,
    requiredFor: Object.freeze(['jank']),
    allowedFor: Object.freeze(['jank']),
  }),
  query: Object.freeze({
    type: 'object',
    nullable: false,
    requiredFor: Object.freeze(['trajectory']),
    allowedFor: Object.freeze(['trajectory']),
    variants: Object.freeze([MOTION_QUERY_VARIANTS.color, MOTION_QUERY_VARIANTS.template]),
  }),
  expectation: Object.freeze({
    type: 'object',
    requiredFor: Object.freeze(['freeze']),
    allowedFor: Object.freeze(['freeze']),
    additionalProperties: false,
    required: Object.freeze(['motionExpected', 'sourceEventId', 'referenceEventIds']),
    fields: Object.freeze({
      motionExpected: Object.freeze({ type: 'boolean', const: true }),
      sourceEventId: Object.freeze({
        type: 'string', minBytes: 1, maxBytes: MOTION_EXPECTATION_LIMITS.maxEventIdBytes,
      }),
      referenceEventIds: Object.freeze({
        type: 'array',
        itemType: 'string',
        itemMinBytes: 1,
        itemMaxBytes: MOTION_EXPECTATION_LIMITS.maxEventIdBytes,
        minItems: 1,
        maxItems: MOTION_EXPECTATION_LIMITS.maxReferenceIds,
        uniqueItems: true,
      }),
    }),
  }),
});

/**
 * 时间分辨率窗口（TOOL-P1-03）：该断言“最短需要分辨的事件时长”。
 * 实测中位采样间隔大于该窗口时，只能说明采样太粗、不能证明“异常未发生”；
 * buildMotionResult 会如实写入 metrics.sampling 与 limitations，且不改变 PASS/FAIL 语义。
 */
const MOTION_SAMPLING_WINDOWS = Object.freeze({
  'frame-diff': Object.freeze({ kind: 'none' }),
  'region-change': Object.freeze({ kind: 'none' }),
  flicker: Object.freeze({
    kind: 'threshold',
    key: 'maxDurationMs',
    defaultMs: T4_THRESHOLDS.flicker.defaults.maxDurationMs,
  }),
  freeze: Object.freeze({
    kind: 'threshold',
    key: 'minDurationMs',
    defaultMs: T4_THRESHOLDS.freeze.defaults.minDurationMs,
  }),
  jank: Object.freeze({
    kind: 'derived',
    formula: 'expectedIntervalMs*intervalFactor',
    intervalFactor: T4_THRESHOLDS.jank.defaults.intervalFactor,
  }),
  trajectory: Object.freeze({ kind: 'none' }),
  transition: Object.freeze({ kind: 'none' }),
});
const MOTION_SAMPLING_TYPES = Object.freeze(['flicker', 'freeze', 'jank', 'transition']);
const SAMPLING_COARSER_THAN_WINDOW = 'sampling-coarser-than-assertion-window';

function motionAssertionAllowedFields(type) {
  return Object.freeze([...MOTION_ASSERTION_BASE_FIELDS, ...MOTION_TYPE_RULES[type].conditional]);
}

function motionAssertionRequiredFields(type) {
  return Object.freeze(['id', 'type', ...MOTION_TYPE_RULES[type].required]);
}

function thresholdFieldSpec(type, key) {
  const range = THRESHOLD_RANGES[key];
  return Object.freeze({
    type: 'number',
    min: range.min,
    max: range.max,
    integer: range.integer === true,
    default: T4_THRESHOLDS[type].defaults[key],
  });
}

/**
 * 机器可读的断言规格（供 browser_capabilities.dynamic.assertions 直接投影）。
 * `byType[type].thresholds.allowed/defaults` 直接引用 T4_THRESHOLDS 的冻结对象，
 * `allowed/required` 由 MOTION_TYPE_RULES 派生 —— 与 validateMotionAssertions 同源。
 */
export const MOTION_ASSERTION_SCHEMA = Object.freeze({
  version: 1,
  algorithmVersion: T4_ALGORITHM_VERSION,
  maxAssertions: T4_LIMITS.maxAssertions,
  idMaxBytes: 64,
  types: MOTION_TYPES,
  fields: MOTION_FIELD_SPECS,
  byType: Object.freeze(Object.fromEntries(MOTION_TYPES.map((type) => [type, Object.freeze({
    allowed: motionAssertionAllowedFields(type),
    required: motionAssertionRequiredFields(type),
    thresholds: Object.freeze({
      allowed: T4_THRESHOLDS[type].allowed,
      defaults: T4_THRESHOLDS[type].defaults,
      fields: Object.freeze(Object.fromEntries(
        T4_THRESHOLDS[type].allowed.map((key) => [key, thresholdFieldSpec(type, key)]),
      )),
    }),
    samplingWindow: MOTION_SAMPLING_WINDOWS[type],
    samplingDisclosure: MOTION_SAMPLING_TYPES.includes(type),
  })]))),
});

function budgetFailure(kind) {
  const error = new Error(kind);
  error.budgetKind = kind;
  return error;
}

/**
 * 单次调用的累计算法预算（跨全部 assertions 共用，不按 assertion 重置）。
 * 同步原语在检查点调用 `check()`；超限/取消等价于 T4 的 DYNAMIC_TIMEOUT/ABORTED 语义。
 */
function createOperationBudget({ signal = null, budgetMs = null, startedAt = null } = {}) {
  const start = Number.isFinite(startedAt) ? startedAt : Date.now();
  const limitMs = Number.isFinite(budgetMs) && budgetMs >= 0 ? budgetMs : T4_LIMITS.algorithmBudgetMs;
  return {
    startedAt: start,
    limitMs,
    checks: 0,
    check() {
      this.checks += 1;
      if (signal && signal.aborted) throw budgetFailure('aborted');
      if (Date.now() - start > limitMs) throw budgetFailure('timeout');
    },
  };
}

function primitiveInput(input, label) {
  const value = input === undefined ? {} : input;
  if (!isPlainObject(value)) badArgument('input', 'not-an-object', label);
  assertAllowedKeys(value, PRIMITIVE_INPUT_KEYS, label);
  if (value.signal && value.signal.aborted) throw new BrowserError('ABORTED', '分析已取消', { operation: label });
  return value;
}

function convertVisionArgument(error, field) {
  if (error instanceof BrowserError && error.code === 'INVALID_ARGUMENT') {
    return new BrowserError('DYNAMIC_INVALID_ARGUMENT', error.message, {
      field, reason: error.details?.reason ?? 'invalid-argument', label: 'analyze',
    });
  }
  return error;
}

function resolveThresholds(type, thresholds) {
  const spec = T4_THRESHOLDS[type];
  if (!spec) badArgument('type', 'invalid-enum', 'thresholds');
  const resolved = { ...spec.defaults };
  if (thresholds === undefined || thresholds === null) return resolved;
  if (!isPlainObject(thresholds)) badArgument('thresholds', 'not-an-object', type);
  assertAllowedKeys(thresholds, spec.allowed, `thresholds.${type}`);
  for (const key of Object.keys(thresholds)) {
    const range = THRESHOLD_RANGES[key];
    const value = thresholds[key];
    if (typeof value !== 'number' || !Number.isFinite(value)) badArgument(key, 'not-a-finite-number', `thresholds.${type}`);
    if (range.integer && !Number.isInteger(value)) badArgument(key, 'not-an-integer', `thresholds.${type}`);
    if (value < range.min) badArgument(key, `below-min:${range.min}`, `thresholds.${type}`);
    if (value > range.max) badArgument(key, `above-max:${range.max}`, `thresholds.${type}`);
    resolved[key] = value;
  }
  return resolved;
}

function normalizeAnalysisFrames(frames, options = {}) {
  const materialize = options.materialize !== false;
  if (!Array.isArray(frames)) badArgument('frames', 'not-an-array', 'analyze');
  if (frames.length > 400) badArgument('frames', 'too-many-items', 'analyze');
  const seen = new Set();
  const normalized = frames.map((frame, index) => {
    const label = `frames[${index}]`;
    if (!isPlainObject(frame)) badArgument(label, 'not-an-object', 'analyze');
    assertAllowedKeys(frame, [
      'frameId', 'seq', 'timelineMs', 'receivedMonoMs', 'sourceTimestamp', 'sourceClock',
      'mapping', 'image', 'clockUncertain', 'incomplete', 'encoding', 'segmentId',
      'bytes', 'encodedBytes', 'bytesLength', 'sha256', 'encodedSha256', 'rgbaSha256',
      'dimensions', 'width', 'height', 'pinned', 'decode', 'provenance', 'ack',
      'documentEpoch', 'runGeneration', 'scopeId', 'dynamicSessionId', 'frameSeq',
    ], label);
    const frameId = readNullableString(frame, 'frameId', label, { maxBytes: 128 }) ?? `f${index}`;
    if (seen.has(frameId)) badArgument('frameId', 'duplicate-id', 'analyze');
    seen.add(frameId);
    let image = null;
    if (frame.image !== undefined && frame.image !== null) image = validateImage(frame.image, `${label}.image`);
    else if (materialize) {
      const encoded = frame.bytes ?? frame.encodedBytes;
      if (encoded !== undefined && encoded !== null && (encoded instanceof Uint8Array || Buffer.isBuffer(encoded))) {
        const decoded = decodeFrameRgba({ encoding: frame.encoding ?? null, bytes: encoded });
        if (decoded.ok) {
          const rgba = decoded.rgba instanceof Uint8Array
            ? decoded.rgba
            : new Uint8Array(decoded.rgba.buffer, decoded.rgba.byteOffset, decoded.rgba.byteLength);
          image = { width: decoded.width, height: decoded.height, rgba };
        }
      }
    }
    let mapping = null;
    if (frame.mapping !== undefined && frame.mapping !== null) {
      if (!isPlainObject(frame.mapping)) badArgument('mapping', 'not-an-object', label);
      mapping = cloneJson(frame.mapping);
    }
    const incomplete = frame.incomplete === undefined ? [] : frame.incomplete;
    if (!Array.isArray(incomplete)) badArgument('incomplete', 'not-an-array', label);
    return {
      frameId,
      seq: readNullableNumber(frame, 'seq', label, { min: 0, integer: true }),
      timelineMs: readNullableNumber(frame, 'timelineMs', label),
      receivedMonoMs: readNullableNumber(frame, 'receivedMonoMs', label, { min: 0 }),
      sourceTimestamp: readNullableNumber(frame, 'sourceTimestamp', label, { min: 0 }),
      sourceClock: readNullableString(frame, 'sourceClock', label, { maxBytes: 64 }),
      mapping,
      image,
      encoding: readNullableString(frame, 'encoding', label, { maxBytes: 16 }),
      segmentId: readNullableString(frame, 'segmentId', label, { maxBytes: 128 }),
      clockUncertain: readBoolean(frame, 'clockUncertain', label, false),
      incomplete,
    };
  });
  if (normalized.length > 0
    && normalized.every((frame) => Number.isInteger(frame.seq))
    && new Set(normalized.map((frame) => frame.seq)).size === normalized.length) {
    normalized.sort((left, right) => left.seq - right.seq);
  }
  return normalized;
}

/** 统一时间轴：优先 timelineMs，其次 receivedMonoMs，最后 sourceTimestamp*1000；混用不拼接。 */
function frameTimes(frames) {
  if (frames.length === 0) return { times: null, source: null };
  if (frames.every((frame) => Number.isFinite(frame.timelineMs))) {
    return { times: frames.map((frame) => frame.timelineMs), source: 'timeline' };
  }
  if (frames.every((frame) => Number.isFinite(frame.receivedMonoMs))) {
    return { times: frames.map((frame) => frame.receivedMonoMs), source: 'received' };
  }
  if (frames.every((frame) => Number.isFinite(frame.sourceTimestamp))) {
    return { times: frames.map((frame) => frame.sourceTimestamp * 1000), source: 'source' };
  }
  return { times: null, source: null };
}

/* ------------------------------------------------------------------ */
/* 采样真实性（TOOL-P1-03）：实测帧间隔统计                            */
/* ------------------------------------------------------------------ */

/**
 * 采样时间基准：sourceTimestamp（秒→毫秒）优先；否则 receivedMonoMs；否则 timelineMs。
 * 只使用“整段帧都有”的基准，不把不同时钟拼成一条时间轴（那会伪造均匀间隔）。
 * 与 frameTimes 的优先级不同是刻意的：frameTimes 服务于时长语义，采样统计要的是
 * 采集侧真实间隔（sourceTimestamp 为采集时间戳，screenshot-loop 则缺省为 receivedMonoMs）。
 */
function samplingTimeBase(frames) {
  if (frames.length === 0) return { times: null, source: null };
  if (frames.every((frame) => Number.isFinite(frame.sourceTimestamp))) {
    return { times: frames.map((frame) => frame.sourceTimestamp * 1000), source: 'source-timestamp' };
  }
  if (frames.every((frame) => Number.isFinite(frame.receivedMonoMs))) {
    return { times: frames.map((frame) => frame.receivedMonoMs), source: 'received-mono' };
  }
  if (frames.every((frame) => Number.isFinite(frame.timelineMs))) {
    return { times: frames.map((frame) => frame.timelineMs), source: 'timeline' };
  }
  return { times: null, source: null };
}

/** 有 seq 就按 seq 排（与 normalizeAnalysisFrames 一致），否则保留调用方顺序。 */
function orderFramesForSampling(frames) {
  for (let index = 0; index < frames.length; index += 1) {
    if (!isPlainObject(frames[index])) badArgument(`frames[${index}]`, 'not-an-object', 'computeFrameSampling');
  }
  if (frames.length <= 1) return [...frames];
  const seqs = frames.map((item) => item.seq);
  if (seqs.every((seq) => Number.isInteger(seq)) && new Set(seqs).size === seqs.length) {
    return [...frames].sort((left, right) => left.seq - right.seq);
  }
  return [...frames];
}

function intervalStatsOf(intervals) {
  if (intervals.length === 0) return { count: 0, p50: null, p95: null, min: null, max: null, mean: null };
  const sorted = [...intervals].sort((left, right) => left - right);
  const sum = intervals.reduce((total, value) => total + value, 0);
  return {
    count: intervals.length,
    p50: percentile(intervals, 50),
    p95: percentile(intervals, 95),
    min: sorted[0],
    max: sorted[sorted.length - 1],
    mean: sum / intervals.length,
  };
}

/**
 * 计算帧序列的实测采样间隔（TOOL-P1-03 内核，冻结/卡顿/过渡/闪烁共用）。
 *
 * @param {Array<object>} frames 帧记录（可用 `seq` 排序；时间基准见 samplingTimeBase）
 * @param {{ assertionWindowMs?: number|null }} [options]
 *   assertionWindowMs：该断言“最短需分辨的事件时长”；实测中位间隔大于它时 sufficient=false
 *   （insufficientReason='sampling-coarser-than-assertion-window'）。缺省只要求至少一个可测间隔。
 * @returns {{
 *   source: 'source-timestamp'|'received-mono'|'timeline'|null,
 *   frameCount: number,
 *   intervals: { count:number, p50:number|null, p95:number|null, min:number|null, max:number|null, mean:number|null },
 *   windowMs: number|null,
 *   firstMs: number|null,
 *   lastMs: number|null,
 *   effectiveFps: number|null,
 *   assertionWindowMs: number|null,
 *   sufficient: boolean,
 *   insufficientReason: 'no-interval'|'sampling-coarser-than-assertion-window'|null
 * }}
 * 只输出实测值，不把“没看到异常”升级成“未发生”；调用方必须结合 verdict/limitations 解读。
 */
export function computeFrameSampling(frames, options = {}) {
  if (!Array.isArray(frames)) badArgument('frames', 'not-an-array', 'computeFrameSampling');
  if (!isPlainObject(options)) badArgument('options', 'not-an-object', 'computeFrameSampling');
  const assertionWindowMs = hasOwn(options, 'assertionWindowMs') ? options.assertionWindowMs : null;
  if (assertionWindowMs !== null
    && (typeof assertionWindowMs !== 'number' || !Number.isFinite(assertionWindowMs) || assertionWindowMs < 0)) {
    badArgument('assertionWindowMs', 'must-be-a-non-negative-finite-number-or-null', 'computeFrameSampling');
  }
  const ordered = orderFramesForSampling(frames);
  const base = samplingTimeBase(ordered);
  const intervals = [];
  if (base.times !== null) {
    for (let index = 1; index < base.times.length; index += 1) {
      intervals.push(base.times[index] - base.times[index - 1]);
    }
  }
  const stats = intervalStatsOf(intervals);
  const windowMs = base.times !== null && base.times.length >= 2
    ? base.times[base.times.length - 1] - base.times[0]
    : null;
  const sufficient = stats.count > 0 && (assertionWindowMs === null || stats.p50 <= assertionWindowMs);
  return {
    source: base.source,
    frameCount: ordered.length,
    intervals: stats,
    windowMs,
    firstMs: base.times !== null ? base.times[0] : null,
    lastMs: base.times !== null ? base.times[base.times.length - 1] : null,
    effectiveFps: windowMs !== null && windowMs > 0 ? (stats.count / windowMs) * 1000 : null,
    assertionWindowMs,
    sufficient,
    insufficientReason: stats.count === 0
      ? 'no-interval'
      : (sufficient ? null : SAMPLING_COARSER_THAN_WINDOW),
  };
}

/** 断言的采样窗口（毫秒）：阈值类取 resolvedThresholds，jank 取 expectedIntervalMs×factor。 */
function resolveSamplingWindowMs(type, thresholds, metrics) {
  const window = MOTION_SAMPLING_WINDOWS[type];
  if (!window || window.kind === 'none') return null;
  if (window.kind === 'threshold') {
    const value = thresholds && Number.isFinite(thresholds[window.key])
      ? thresholds[window.key]
      : window.defaultMs;
    return Number.isFinite(value) ? value : null;
  }
  if (window.kind === 'derived') {
    const factor = thresholds && Number.isFinite(thresholds.intervalFactor)
      ? thresholds.intervalFactor
      : window.intervalFactor;
    const expected = metrics && Number.isFinite(metrics.expectedIntervalMs)
      ? metrics.expectedIntervalMs
      : null;
    return Number.isFinite(expected) && Number.isFinite(factor) ? expected * factor : null;
  }
  return null;
}

function sequenceGap(frames) {
  const seqs = frames.map((frame) => frame.seq);
  if (!seqs.every((seq) => Number.isInteger(seq))) return { hasGap: false, unknown: true, ranges: [] };
  const ranges = [];
  for (let index = 1; index < seqs.length; index += 1) {
    if (seqs[index] !== seqs[index - 1] + 1) {
      ranges.push({
        afterSeq: seqs[index - 1],
        beforeSeq: seqs[index],
        missing: Math.max(0, seqs[index] - seqs[index - 1] - 1),
      });
    }
  }
  return { hasGap: ranges.length > 0, unknown: false, ranges };
}

function firstImageDimensions(frames) {
  for (const frame of frames) {
    if (frame.image) return { width: frame.image.width, height: frame.image.height };
  }
  return null;
}

/** mask 并集在给定 region 内覆盖的像素数（矩形并集，坐标压缩；纯预检用）。 */
function maskedAreaWithin(region, masks) {
  const xEdges = new Set([region.x, region.x + region.width]);
  const yEdges = new Set([region.y, region.y + region.height]);
  for (const mask of masks) {
    const left = Math.max(region.x, mask.region.x);
    const right = Math.min(region.x + region.width, mask.region.x + mask.region.width);
    const top = Math.max(region.y, mask.region.y);
    const bottom = Math.min(region.y + region.height, mask.region.y + mask.region.height);
    if (right <= left || bottom <= top) continue;
    xEdges.add(left); xEdges.add(right);
    yEdges.add(top); yEdges.add(bottom);
  }
  const xs = [...xEdges].sort((a, b) => a - b);
  const ys = [...yEdges].sort((a, b) => a - b);
  let covered = 0;
  for (let xi = 0; xi + 1 < xs.length; xi += 1) {
    const left = xs[xi];
    const right = xs[xi + 1];
    if (right <= left) continue;
    const intervals = [];
    for (const mask of masks) {
      const maskLeft = Math.max(region.x, mask.region.x);
      const maskRight = Math.min(region.x + region.width, mask.region.x + mask.region.width);
      if (maskLeft > left || maskRight < right) continue;
      const top = Math.max(region.y, mask.region.y);
      const bottom = Math.min(region.y + region.height, mask.region.y + mask.region.height);
      if (bottom > top) intervals.push([top, bottom]);
    }
    intervals.sort((a, b) => a[0] - b[0]);
    let coveredY = 0;
    let cursor = null;
    for (const [top, bottom] of intervals) {
      if (cursor === null || top > cursor) {
        coveredY += bottom - top;
        cursor = bottom;
      } else if (bottom > cursor) {
        coveredY += bottom - cursor;
        cursor = bottom;
      }
    }
    covered += (right - left) * coveredY;
  }
  return covered;
}

function resolveRegionAndMasks(input, frames) {
  let region = null;
  if (input.region !== undefined && input.region !== null) {
    try {
      region = validatePixelRect(input.region, 'region');
    } catch (error) {
      throw convertVisionArgument(error, 'region');
    }
    const dims = firstImageDimensions(frames);
    if (dims && (region.x + region.width > dims.width || region.y + region.height > dims.height)) {
      badArgument('region', 'out-of-bounds', 'analyze');
    }
  }
  let masks = [];
  if (input.masks !== undefined && input.masks !== null) {
    try {
      masks = validateMasks(input.masks, 'masks');
    } catch (error) {
      throw convertVisionArgument(error, 'masks');
    }
    const dims = firstImageDimensions(frames);
    if (dims) {
      for (const mask of masks) {
        if (mask.region.x + mask.region.width > dims.width || mask.region.y + mask.region.height > dims.height) {
          badArgument('masks', 'out-of-bounds', 'analyze');
        }
      }
    }
    // 纯预检即可判定“全 mask”（显式 region 被 mask 并集完全覆盖）→ 参数非法；
    // region 缺省时只有实际读图才知道 C=0，留给运行时 INCONCLUSIVE/empty-comparison。
    if (region !== null && masks.length > 0
      && maskedAreaWithin(region, masks) >= region.width * region.height) {
      badArgument('masks', 'full-mask', 'analyze');
    }
  }
  return { region, masks };
}

function normalizeContextEvents(events, label = 'events') {
  if (events === undefined || events === null) return null;
  if (!Array.isArray(events)) badArgument(label, 'not-an-array', 'analyze');
  if (events.length > 20000) badArgument(label, 'too-many-items', 'analyze');
  return events.map((event, index) => {
    if (!isPlainObject(event)) badArgument(`${label}[${index}]`, 'not-an-object', 'analyze');
    return normalizeDynamicEvent(event, {});
  });
}

function frameClassifications(frames) {
  const classifications = [];
  if (frames.some((frame) => frame.clockUncertain === true)) classifications.push('clock-uncertain');
  return classifications;
}

function baseFrameMetrics(frames) {
  return {
    frameIds: frames.map((frame) => frame.frameId),
    sampleCount: frames.length,
  };
}

/**
 * 编码精度投影（契约 §3.4/§4）：jpeg → precise=false；png → precise=true；
 * 同批混用 → 'mixed' 且 precise=false（不因一帧 PNG 就宣称整段精确）。
 */
function framesPrecision(frames) {
  const encodings = [...new Set(frames.map((frame) => frame.encoding).filter((value) => value !== null))];
  if (encodings.length === 0) return { encoding: null, precise: true };
  if (encodings.length > 1) return { encoding: 'mixed', precise: false };
  return { encoding: encodings[0], precise: encodings[0] !== 'jpeg' };
}

function buildMotionResult(type, frames, options) {
  const {
    verdict,
    status,
    reasons = [],
    limitations = [],
    classifications = [],
    metrics = null,
    region = null,
    masks = [],
    resolvedThresholds = null,
    evidenceIds = [],
    extra = {},
  } = options;
  const timeInfo = frameTimes(frames);
  const precision = framesPrecision(frames);
  const mergedClassifications = [...new Set([...frameClassifications(frames), ...classifications])];
  const mergedLimitations = [...new Set(limitations)];
  if (!precision.precise) mergedLimitations.push('jpeg-compression-noise');
  // TOOL-P1-03：只对时间语义断言附实测采样统计；采样不足如实标注 limitation，不改 verdict。
  let mergedMetrics = metrics;
  if (isPlainObject(metrics) && MOTION_SAMPLING_TYPES.includes(type)) {
    const sampling = computeFrameSampling(frames, {
      assertionWindowMs: resolveSamplingWindowMs(type, resolvedThresholds, metrics),
    });
    mergedMetrics = { ...metrics, sampling };
    // BLOCKED(no-frames) 已由 reasons 说明没有样本，不再叠加“采样过粗”的噪声。
    if (!sampling.sufficient && verdict !== 'BLOCKED') mergedLimitations.push(SAMPLING_COARSER_THAN_WINDOW);
  }
  let resolvedStatus = status;
  if (!resolvedStatus) {
    if (verdict === 'PASS' || verdict === 'WARN' || verdict === 'FAIL') resolvedStatus = 'resolved';
    else if (verdict === 'BLOCKED') resolvedStatus = 'blocked';
    else resolvedStatus = 'inconclusive';
  }
  return {
    ok: verdict === 'PASS' || verdict === 'WARN',
    type,
    status: resolvedStatus,
    verdict,
    algorithmVersion: T4_ALGORITHM_VERSION,
    ...baseFrameMetrics(frames),
    fromMs: timeInfo.times ? timeInfo.times[0] : null,
    toMs: timeInfo.times ? timeInfo.times[timeInfo.times.length - 1] : null,
    timeSource: timeInfo.source,
    encoding: precision.encoding,
    precise: precision.precise,
    region: region ?? null,
    masks,
    resolvedThresholds,
    metrics: mergedMetrics,
    evidenceIds: [...new Set([...frames.map((frame) => frame.frameId), ...evidenceIds])],
    reasons: [...new Set(reasons)],
    limitations: mergedLimitations,
    classifications: mergedClassifications,
    ...extra,
  };
}

/** 相邻帧 YIQ 差；错误以稳定 code 返回而不是抛（分母 0/尺寸/mapping 都属证据不足）。 */
function diffPair(left, right, { region, masks, pixelThreshold }) {
  if (!left.image || !right.image) return { error: 'decoder-unavailable' };
  if (left.image.width !== right.image.width || left.image.height !== right.image.height) {
    return { error: 'size-mismatch' };
  }
  if (left.mapping && right.mapping && !mappingCompatible(left.mapping, right.mapping)) {
    return { error: 'mapping-incompatible' };
  }
  try {
    const diff = diffImages(left.image, right.image, {
      region: region ?? undefined,
      masks: masks && masks.length > 0 ? masks : undefined,
      options: { threshold: pixelThreshold, includeAA: false, minRegionPixels: 1 },
    });
    return {
      diffRatio: diff.metrics.diffRatio,
      comparedPixels: diff.metrics.comparedPixels,
      diffPixels: diff.metrics.diffPixels,
      maskPixels: diff.metrics.maskedPixels,
      regions: diff.regions,
      regionCount: diff.regionCount,
      regionsTruncated: diff.regionsTruncated,
    };
  } catch (error) {
    if (error instanceof BrowserError && error.code === 'VISION_EMPTY_COMPARISON') {
      return { error: 'empty-comparison' };
    }
    if (error instanceof BrowserError && error.code === 'VISION_SIZE_MISMATCH') {
      return { error: 'size-mismatch' };
    }
    if (error instanceof BrowserError && error.code === 'INVALID_ARGUMENT') {
      throw convertVisionArgument(error, 'region');
    }
    throw error;
  }
}

function meanLuma(image, region) {
  const { width, height, rgba } = image;
  const area = region ?? { x: 0, y: 0, width, height };
  const endX = Math.min(width, area.x + area.width);
  const endY = Math.min(height, area.y + area.height);
  if (endX <= area.x || endY <= area.y) return null;
  let sum = 0;
  let count = 0;
  for (let y = area.y; y < endY; y += 1) {
    for (let x = area.x; x < endX; x += 1) {
      const offset = (y * width + x) * 4;
      const alpha = rgba[offset + 3] / 255;
      const red = rgba[offset] * alpha + 255 * (1 - alpha);
      const green = rgba[offset + 1] * alpha + 255 * (1 - alpha);
      const blue = rgba[offset + 2] * alpha + 255 * (1 - alpha);
      sum += 0.299 * red + 0.587 * green + 0.114 * blue;
      count += 1;
    }
  }
  return count === 0 ? null : sum / count;
}

function percentile(values, p) {
  if (!Array.isArray(values) || values.length === 0) return null;
  const sorted = [...values].sort((left, right) => left - right);
  const rank = Math.ceil((p / 100) * sorted.length);
  return sorted[Math.min(sorted.length - 1, Math.max(0, rank - 1))];
}

function pairErrorVerdict(type, frames, errors, gap, extraReasons = []) {
  const first = errors[0];
  const reasons = [first ? first.code : 'insufficient-samples', ...extraReasons];
  const limitations = [];
  if (gap.hasGap) limitations.push('missing-intermediate-frames');
  if (gap.unknown) limitations.push('sequence-unknown');
  for (const error of errors) limitations.push(`${error.code}:${error.fromFrameId}->${error.toFrameId}`);
  return buildMotionResult(type, frames, {
    verdict: 'INCONCLUSIVE',
    reasons,
    limitations,
    metrics: { errors, pairs: [] },
  });
}

/* ------------------------------------------------------------------ */
/* 1) 帧差                                                            */
/* ------------------------------------------------------------------ */

export function analyzeFrameDiff(input) {
  const options = primitiveInput(input, 'analyzeFrameDiff');
  const budget = options.budget ?? null;
  if (budget) budget.check();
  const frames = normalizeAnalysisFrames(options.frames);
  const thresholds = resolveThresholds('frame-diff', options.thresholds);
  const { region, masks } = resolveRegionAndMasks(options, frames);
  const gap = sequenceGap(frames);
  if (frames.length < 2) {
    return buildMotionResult('frame-diff', frames, {
      verdict: 'INCONCLUSIVE',
      reasons: ['insufficient-samples'],
      limitations: gap.unknown ? ['sequence-unknown'] : [],
      region,
      masks,
      resolvedThresholds: thresholds,
      metrics: { requiredSamples: 2, pairs: [] },
    });
  }
  const pairs = [];
  const errors = [];
  for (let index = 1; index < frames.length; index += 1) {
    if (budget) budget.check();
    const left = frames[index - 1];
    const right = frames[index];
    const diff = diffPair(left, right, { region, masks, pixelThreshold: thresholds.pixelThreshold });
    if (diff.error) {
      errors.push({ code: diff.error, fromFrameId: left.frameId, toFrameId: right.frameId });
      continue;
    }
    pairs.push({
      fromFrameId: left.frameId,
      toFrameId: right.frameId,
      seqGap: Number.isInteger(left.seq) && Number.isInteger(right.seq) ? right.seq - left.seq : null,
      intervalMs: Number.isFinite(left.timelineMs) && Number.isFinite(right.timelineMs)
        ? right.timelineMs - left.timelineMs
        : null,
      diffRatio: diff.diffRatio,
      diffPixels: diff.diffPixels,
      comparedPixels: diff.comparedPixels,
      maskPixels: diff.maskPixels,
      regionCount: diff.regionCount,
    });
  }
  const changed = pairs.filter((pair) => pair.diffRatio >= thresholds.changeRatio);
  const metrics = {
    pairs,
    changedPairs: changed.length,
    maxDiffRatio: pairs.length > 0 ? Math.max(...pairs.map((pair) => pair.diffRatio)) : null,
    errors,
  };
  if (changed.length > 0) {
    const limitations = [];
    if (gap.hasGap) limitations.push('missing-intermediate-frames');
    if (gap.unknown) limitations.push('sequence-unknown');
    if (errors.length > 0) limitations.push(`partial-comparison-errors:${errors.length}`);
    return buildMotionResult('frame-diff', frames, {
      verdict: 'FAIL',
      reasons: ['change-detected'],
      limitations,
      region,
      masks,
      resolvedThresholds: thresholds,
      metrics,
    });
  }
  if (errors.length > 0) return pairErrorVerdict('frame-diff', frames, errors, gap);
  if (gap.hasGap) {
    return buildMotionResult('frame-diff', frames, {
      verdict: 'INCONCLUSIVE',
      reasons: ['missing-intermediate-frames'],
      limitations: ['missing-intermediate-frames'],
      region,
      masks,
      resolvedThresholds: thresholds,
      metrics,
    });
  }
  return buildMotionResult('frame-diff', frames, {
    verdict: 'PASS',
    reasons: ['no-change'],
    limitations: gap.unknown ? ['sequence-unknown'] : [],
    region,
    masks,
    resolvedThresholds: thresholds,
    metrics,
  });
}

/* ------------------------------------------------------------------ */
/* 2) 区域变化                                                        */
/* ------------------------------------------------------------------ */

export function analyzeRegionChange(input) {
  const options = primitiveInput(input, 'analyzeRegionChange');
  const budget = options.budget ?? null;
  if (budget) budget.check();
  const frames = normalizeAnalysisFrames(options.frames);
  const thresholds = resolveThresholds('region-change', options.thresholds);
  const { region, masks } = resolveRegionAndMasks(options, frames);
  const gap = sequenceGap(frames);
  if (frames.length < 2) {
    return buildMotionResult('region-change', frames, {
      verdict: 'INCONCLUSIVE',
      reasons: ['insufficient-samples'],
      region,
      masks,
      resolvedThresholds: thresholds,
      metrics: { pairs: [], regions: [] },
    });
  }
  const pairs = [];
  const errors = [];
  const allRegions = [];
  for (let index = 1; index < frames.length; index += 1) {
    if (budget) budget.check();
    const left = frames[index - 1];
    const right = frames[index];
    const diff = diffPair(left, right, {
      region,
      masks,
      pixelThreshold: thresholds.pixelThreshold,
    });
    if (diff.error) {
      errors.push({ code: diff.error, fromFrameId: left.frameId, toFrameId: right.frameId });
      continue;
    }
    const pairRegions = diff.regions
      .filter((item) => item.area >= thresholds.minArea)
      .map((item) => ({
        id: `${left.frameId}->${right.frameId}:${item.id}`,
        fromFrameId: left.frameId,
        toFrameId: right.frameId,
        area: item.area,
        region: item.imagePixels,
      }));
    allRegions.push(...pairRegions);
    pairs.push({
      fromFrameId: left.frameId,
      toFrameId: right.frameId,
      diffRatio: diff.diffRatio,
      diffPixels: diff.diffPixels,
      comparedPixels: diff.comparedPixels,
      regionCount: diff.regionCount,
      regionsTruncated: diff.regionsTruncated,
    });
  }
  const regions = allRegions.slice(0, T4_LIMITS.maxRegions);
  const truncated = allRegions.length > regions.length;
  const changed = pairs.filter((pair) => pair.diffRatio >= thresholds.changeRatio);
  const limitations = [];
  if (gap.hasGap) limitations.push('missing-intermediate-frames');
  if (gap.unknown) limitations.push('sequence-unknown');
  if (truncated) limitations.push('regions-truncated');
  const metrics = {
    pairs,
    regions,
    regionCount: allRegions.length,
    regionsTruncated: truncated,
    errors,
  };
  if (changed.length > 0) {
    return buildMotionResult('region-change', frames, {
      verdict: 'FAIL',
      reasons: ['region-change-detected'],
      limitations: errors.length > 0 ? [...limitations, `partial-comparison-errors:${errors.length}`] : limitations,
      region,
      masks,
      resolvedThresholds: thresholds,
      metrics,
    });
  }
  if (errors.length > 0) return pairErrorVerdict('region-change', frames, errors, gap);
  if (allRegions.length > 0) {
    return buildMotionResult('region-change', frames, {
      verdict: 'PASS',
      reasons: ['below-change-ratio'],
      limitations,
      region,
      masks,
      resolvedThresholds: thresholds,
      metrics,
    });
  }
  if (gap.hasGap) {
    return buildMotionResult('region-change', frames, {
      verdict: 'INCONCLUSIVE',
      reasons: ['missing-intermediate-frames'],
      limitations,
      region,
      masks,
      resolvedThresholds: thresholds,
      metrics,
    });
  }
  return buildMotionResult('region-change', frames, {
    verdict: 'PASS',
    reasons: ['no-region-change'],
    limitations,
    region,
    masks,
    resolvedThresholds: thresholds,
    metrics,
  });
}

/* ------------------------------------------------------------------ */
/* 3) 闪烁                                                            */
/* ------------------------------------------------------------------ */

export function analyzeFlicker(input) {
  const options = primitiveInput(input, 'analyzeFlicker');
  const budget = options.budget ?? null;
  if (budget) budget.check();
  const frames = normalizeAnalysisFrames(options.frames);
  const thresholds = resolveThresholds('flicker', options.thresholds);
  const { region, masks } = resolveRegionAndMasks(options, frames);
  const gap = sequenceGap(frames);
  if (frames.length < 3) {
    return buildMotionResult('flicker', frames, {
      verdict: 'INCONCLUSIVE',
      reasons: ['insufficient-samples'],
      limitations: ['needs-three-frames'],
      region,
      masks,
      resolvedThresholds: thresholds,
      metrics: { candidates: [], rejected: [], requiredSamples: 3 },
    });
  }
  const timeInfo = frameTimes(frames);
  const times = timeInfo.times;
  const verified = [];
  const unverifiedTime = [];
  const tooLong = [];
  const belowBrightness = [];
  const errors = [];
  const subThreshold = [];
  for (let index = 0; index + 2 < frames.length; index += 1) {
    if (budget) budget.check();
    const first = frames[index];
    const middle = frames[index + 1];
    const last = frames[index + 2];
    const before = diffPair(first, middle, { region, masks, pixelThreshold: thresholds.pixelThreshold });
    const after = diffPair(middle, last, { region, masks, pixelThreshold: thresholds.pixelThreshold });
    const sides = diffPair(first, last, { region, masks, pixelThreshold: thresholds.pixelThreshold });
    if (before.error || after.error || sides.error) {
      errors.push({
        code: before.error ?? after.error ?? sides.error,
        fromFrameId: first.frameId,
        toFrameId: last.frameId,
      });
      continue;
    }
    const candidate = {
      fromFrameId: first.frameId,
      middleFrameId: middle.frameId,
      toFrameId: last.frameId,
      changeRatioBefore: before.diffRatio,
      changeRatioAfter: after.diffRatio,
      sidesRatio: sides.diffRatio,
      brightnessDelta: null,
      durationMs: null,
    };
    if (!(before.diffRatio >= thresholds.changeRatio
      && after.diffRatio >= thresholds.changeRatio
      && sides.diffRatio <= thresholds.stableRatio)) {
      subThreshold.push(candidate);
      continue;
    }
    const lumaFirst = first.image ? meanLuma(first.image, region) : null;
    const lumaMiddle = middle.image ? meanLuma(middle.image, region) : null;
    if (lumaFirst === null || lumaMiddle === null) {
      errors.push({ code: 'decoder-unavailable', fromFrameId: first.frameId, toFrameId: last.frameId });
      continue;
    }
    candidate.brightnessDelta = Math.abs(lumaMiddle - lumaFirst);
    if (candidate.brightnessDelta < thresholds.brightnessDelta) {
      belowBrightness.push(candidate);
      continue;
    }
    if (times === null) {
      unverifiedTime.push(candidate);
      continue;
    }
    candidate.durationMs = times[index + 2] - times[index + 1];
    if (candidate.durationMs > thresholds.maxDurationMs) {
      tooLong.push(candidate);
      continue;
    }
    verified.push(candidate);
  }
  const metrics = {
    candidates: verified,
    subThreshold,
    belowBrightness,
    tooLong,
    unverifiedTime,
    errors,
  };
  const limitations = [];
  if (gap.hasGap) limitations.push('missing-intermediate-frames');
  if (gap.unknown) limitations.push('sequence-unknown');
  if (timeInfo.source === 'received') limitations.push('duration-from-received-mono');
  if (verified.length > 0) {
    return buildMotionResult('flicker', frames, {
      verdict: 'FAIL',
      reasons: ['flicker-detected'],
      limitations: errors.length > 0 ? [...limitations, 'partial-comparison-errors'] : limitations,
      region,
      masks,
      resolvedThresholds: thresholds,
      metrics,
    });
  }
  if (unverifiedTime.length > 0) {
    return buildMotionResult('flicker', frames, {
      verdict: 'INCONCLUSIVE',
      reasons: ['missing-time'],
      limitations: [...limitations, 'duration-unverifiable'],
      region,
      masks,
      resolvedThresholds: thresholds,
      metrics,
    });
  }
  if (errors.length > 0) return pairErrorVerdict('flicker', frames, errors, gap);
  if (gap.hasGap) {
    return buildMotionResult('flicker', frames, {
      verdict: 'INCONCLUSIVE',
      reasons: ['missing-intermediate-frames'],
      limitations,
      region,
      masks,
      resolvedThresholds: thresholds,
      metrics,
    });
  }
  if (belowBrightness.length > 0) {
    return buildMotionResult('flicker', frames, {
      verdict: 'PASS',
      reasons: ['brightness-below-threshold'],
      limitations,
      region,
      masks,
      resolvedThresholds: thresholds,
      metrics,
    });
  }
  if (tooLong.length > 0) {
    return buildMotionResult('flicker', frames, {
      verdict: 'PASS',
      reasons: ['flicker-too-long'],
      limitations,
      region,
      masks,
      resolvedThresholds: thresholds,
      metrics,
    });
  }
  // TOOL-P1-03：没有候选不等于“无闪烁”。两种阴性结论都不成立：
  //  1) 实测中位采样间隔粗于断言窗口（maxDurationMs）：短于采样间隔的闪白无法被覆盖；
  //  2) 完全没有可测时间基准（sourceTimestamp/receivedMonoMs/timelineMs 全缺）：
  //     源时钟缺失时无法排除采样间隙里的短闪，不能 PASS。
  // 慢脉冲（flicker-too-long）与低亮度（brightness-below-threshold）分支在上方先返回，
  // 它们有可测间隔且观察到变化，PASS 语义保持不变。
  const sampling = computeFrameSampling(frames, { assertionWindowMs: thresholds.maxDurationMs });
  if (!sampling.sufficient) {
    return buildMotionResult('flicker', frames, {
      verdict: 'INCONCLUSIVE',
      reasons: ['insufficient-temporal-resolution'],
      limitations,
      region,
      masks,
      resolvedThresholds: thresholds,
      metrics,
    });
  }
  return buildMotionResult('flicker', frames, {
    verdict: 'PASS',
    reasons: ['no-flicker'],
    limitations,
    region,
    masks,
    resolvedThresholds: thresholds,
    metrics,
  });
}

/* ------------------------------------------------------------------ */
/* 4) 冻结                                                            */
/* ------------------------------------------------------------------ */

const CONTROL_KIND_PATTERN = /pause|resume|seek|rate|stall|freeze|stop/i;

function validateFreezeExpectation(expectation) {
  if (expectation === undefined || expectation === null) {
    badArgument('expectation', 'missing-required-field', 'freeze');
  }
  if (!isPlainObject(expectation)) badArgument('expectation', 'not-an-object', 'freeze');
  assertAllowedKeys(expectation, ['motionExpected', 'sourceEventId', 'referenceEventIds'], 'expectation');
  if (expectation.motionExpected !== true) badArgument('motionExpected', 'must-be-true', 'expectation');
  const sourceEventId = readString(expectation, 'sourceEventId', 'expectation', {
    required: true, maxBytes: MOTION_EXPECTATION_LIMITS.maxEventIdBytes,
  });
  const referenceEventIds = expectation.referenceEventIds;
  if (!Array.isArray(referenceEventIds) || referenceEventIds.length === 0) {
    badArgument('referenceEventIds', 'empty-array', 'expectation');
  }
  if (referenceEventIds.length > MOTION_EXPECTATION_LIMITS.maxReferenceIds) {
    badArgument('referenceEventIds', 'too-many-items', 'expectation');
  }
  const unique = [];
  for (const id of referenceEventIds) {
    if (typeof id !== 'string' || id.length === 0 || id.length > MOTION_EXPECTATION_LIMITS.maxEventIdBytes) {
      badArgument('referenceEventIds', 'invalid-id', 'expectation');
    }
    if (!unique.includes(id)) unique.push(id);
  }
  return { motionExpected: true, sourceEventId, referenceEventIds: unique };
}

function normalizeAdvancingEvidence(value) {
  if (value === undefined || value === null) return [];
  if (!Array.isArray(value)) badArgument('advancingEvidence', 'not-an-array', 'freeze');
  if (value.length > 16) badArgument('advancingEvidence', 'too-many-items', 'freeze');
  return value.map((item, index) => {
    const label = `advancingEvidence[${index}]`;
    if (!isPlainObject(item)) badArgument(label, 'not-an-object', 'freeze');
    const eventId = readString(item, 'eventId', label, { required: true, maxBytes: 128 });
    const trust = item.trust ?? item.provenance?.trust;
    if (!TRUST_VALUES.includes(trust)) badArgument('trust', 'invalid-enum', label);
    return normalizeDynamicEvent({
      eventId,
      domain: typeof item.domain === 'string' ? item.domain : 'marker',
      kind: typeof item.kind === 'string' ? item.kind : 'advancing-evidence',
      provenance: {
        producer: typeof item.producer === 'string' ? item.producer : 'external-advancing-evidence',
        sourceKind: typeof item.sourceKind === 'string' ? item.sourceKind : 'adapter',
        trust,
        evidenceIds: Array.isArray(item.evidenceIds) ? item.evidenceIds : [],
      },
      payload: isPlainObject(item.payload) ? item.payload : {},
    }, {});
  });
}

export function analyzeFreeze(input) {
  const options = primitiveInput(input, 'analyzeFreeze');
  const budget = options.budget ?? null;
  if (budget) budget.check();
  const frames = normalizeAnalysisFrames(options.frames);
  const thresholds = resolveThresholds('freeze', options.thresholds);
  const { region, masks } = resolveRegionAndMasks(options, frames);
  const expectation = validateFreezeExpectation(options.expectation);
  const gap = sequenceGap(frames);
  const advancing = normalizeAdvancingEvidence(options.advancingEvidence);
  const baseEvents = normalizeContextEvents(options.events, 'events');
  const events = advancing.length === 0
    ? baseEvents
    : [...(baseEvents ?? []), ...advancing];
  const classifications = [];
  const limitations = [];
  if (gap.hasGap) limitations.push('missing-intermediate-frames');
  if (gap.unknown) limitations.push('sequence-unknown');

  if (frames.length < 3) {
    return buildMotionResult('freeze', frames, {
      verdict: 'INCONCLUSIVE',
      reasons: ['insufficient-samples'],
      limitations: [...limitations, 'needs-three-pixel-samples'],
      region,
      masks,
      resolvedThresholds: thresholds,
      metrics: { runs: [], requiredSamples: 3 },
      extra: { expectation },
    });
  }

  if (events === null) {
    return buildMotionResult('freeze', frames, {
      verdict: 'INCONCLUSIVE',
      reasons: ['expectation-unverified'],
      limitations: [...limitations, 'expectation-events-unavailable'],
      region,
      masks,
      resolvedThresholds: thresholds,
      metrics: { runs: [] },
      extra: { expectation },
    });
  }
  const byId = new Map(events.map((event) => [event.eventId, event]));
  const sourceEvent = byId.get(expectation.sourceEventId) ?? null;
  const referenceEvents = expectation.referenceEventIds.map((id) => byId.get(id) ?? null);
  const missingReferences = expectation.referenceEventIds.filter((id) => !byId.has(id));
  if (!sourceEvent) {
    return buildMotionResult('freeze', frames, {
      verdict: 'INCONCLUSIVE',
      reasons: ['expectation-event-missing'],
      limitations,
      region,
      masks,
      resolvedThresholds: thresholds,
      metrics: { runs: [], missingReferences },
      extra: { expectation },
    });
  }
  if (missingReferences.length > 0) {
    return buildMotionResult('freeze', frames, {
      verdict: 'INCONCLUSIVE',
      reasons: ['reference-event-missing'],
      limitations,
      region,
      masks,
      resolvedThresholds: thresholds,
      metrics: { runs: [], missingReferences },
      extra: { expectation },
    });
  }
  const independent = referenceEvents.filter((event) => event
    && (event.provenance.trust === 'host-observed' || event.provenance.trust === 'cdp-observed'));
  if (independent.length === 0) {
    return buildMotionResult('freeze', frames, {
      verdict: 'INCONCLUSIVE',
      reasons: ['advancing-evidence-unverified'],
      limitations: [...limitations, 'reference-events-are-caller-declared'],
      region,
      masks,
      resolvedThresholds: thresholds,
      metrics: { runs: [] },
      extra: { expectation },
    });
  }

  const timeInfo = frameTimes(frames);
  const times = timeInfo.times;
  const pairs = [];
  const errors = [];
  for (let index = 1; index < frames.length; index += 1) {
    if (budget) budget.check();
    const left = frames[index - 1];
    const right = frames[index];
    const diff = diffPair(left, right, { region, masks, pixelThreshold: thresholds.pixelThreshold });
    if (diff.error) {
      errors.push({ code: diff.error, fromFrameId: left.frameId, toFrameId: right.frameId });
      pairs.push(null);
      continue;
    }
    pairs.push({
      fromFrameId: left.frameId,
      toFrameId: right.frameId,
      diffRatio: diff.diffRatio,
      stable: diff.diffRatio <= thresholds.stableRatio,
    });
  }

  const controlEvents = events.filter((event) => event.domain === 'control'
    && CONTROL_KIND_PATTERN.test(event.kind)
    && (event.phase === 'applied' || event.phase === 'completed' || event.phase === null));

  const runs = [];
  let runStart = null;
  for (let index = 0; index < pairs.length; index += 1) {
    const pair = pairs[index];
    if (pair && pair.stable) {
      if (runStart === null) runStart = index;
    } else if (runStart !== null) {
      runs.push({ startPair: runStart, endPair: index });
      runStart = null;
    }
  }
  if (runStart !== null) runs.push({ startPair: runStart, endPair: pairs.length });

  const stableCandidates = runs.map((run) => {
    const startFrame = frames[run.startPair];
    const endFrame = frames[run.endPair];
    const sampleCount = run.endPair - run.startPair + 1;
    const durationMs = times === null ? null : times[run.endPair] - times[run.startPair];
    const controlHits = controlEvents.filter((event) => {
      const time = event.ts.timelineMs;
      if (times === null || !Number.isFinite(time)) return false;
      return time >= times[run.startPair] && time <= times[run.endPair];
    });
    return {
      fromFrameId: startFrame.frameId,
      toFrameId: endFrame.frameId,
      fromMs: times === null ? null : times[run.startPair],
      toMs: times === null ? null : times[run.endPair],
      durationMs,
      sampleCount,
      stable: durationMs !== null && durationMs >= thresholds.minDurationMs && sampleCount >= 3,
      controlEventIds: controlHits.map((event) => event.eventId),
    };
  });
  const stableEnough = stableCandidates.filter((candidate) => candidate.stable);
  const controlExcluded = stableEnough.filter((candidate) => candidate.controlEventIds.length > 0);
  const confirmed = stableEnough.filter((candidate) => candidate.controlEventIds.length === 0);
  const metrics = {
    runs: stableCandidates,
    pairCount: pairs.length,
    errors,
    longestStableMs: stableCandidates.reduce(
      (best, candidate) => (candidate.durationMs !== null && candidate.durationMs > best ? candidate.durationMs : best),
      -1,
    ),
  };
  if (metrics.longestStableMs < 0) metrics.longestStableMs = null;
  if (controlExcluded.length > 0) classifications.push('control-excluded');
  if (confirmed.length > 0) {
    return buildMotionResult('freeze', frames, {
      verdict: 'FAIL',
      reasons: ['freeze-detected'],
      limitations: errors.length > 0 ? [...limitations, 'partial-comparison-errors'] : limitations,
      classifications,
      region,
      masks,
      resolvedThresholds: thresholds,
      metrics,
      evidenceIds: [expectation.sourceEventId, ...expectation.referenceEventIds],
      extra: { expectation, freezeInterval: confirmed[0] },
    });
  }
  if (controlExcluded.length > 0) {
    return buildMotionResult('freeze', frames, {
      verdict: 'INCONCLUSIVE',
      reasons: ['control-excluded'],
      limitations: [...limitations, 'control-event-in-interval'],
      classifications,
      region,
      masks,
      resolvedThresholds: thresholds,
      metrics,
      evidenceIds: [expectation.sourceEventId, ...expectation.referenceEventIds],
      extra: { expectation },
    });
  }
  if (errors.length > 0) {
    return buildMotionResult('freeze', frames, {
      verdict: 'INCONCLUSIVE',
      reasons: [errors[0].code],
      limitations: [...limitations, `comparison-errors:${errors.length}`],
      region,
      masks,
      resolvedThresholds: thresholds,
      metrics,
      extra: { expectation },
    });
  }
  if (stableCandidates.length > 0 && times === null) {
    return buildMotionResult('freeze', frames, {
      verdict: 'INCONCLUSIVE',
      reasons: ['missing-time'],
      limitations: [...limitations, 'duration-unverifiable'],
      region,
      masks,
      resolvedThresholds: thresholds,
      metrics,
      extra: { expectation },
    });
  }
  if (gap.hasGap) {
    return buildMotionResult('freeze', frames, {
      verdict: 'INCONCLUSIVE',
      reasons: ['missing-intermediate-frames'],
      limitations,
      region,
      masks,
      resolvedThresholds: thresholds,
      metrics,
      extra: { expectation },
    });
  }
  if (!framesPrecision(frames).precise) {
    return buildMotionResult('freeze', frames, {
      verdict: 'INCONCLUSIVE',
      reasons: ['jpeg-non-precise'],
      limitations: [...limitations, 'jpeg-stability-not-precise'],
      region,
      masks,
      resolvedThresholds: thresholds,
      metrics,
      extra: { expectation },
    });
  }
  return buildMotionResult('freeze', frames, {
    verdict: 'PASS',
    reasons: [stableCandidates.length > 0 ? 'stable-duration-too-short' : 'no-freeze'],
    limitations,
    region,
    masks,
    resolvedThresholds: thresholds,
    metrics,
    extra: { expectation },
  });
}

/* ------------------------------------------------------------------ */
/* 5) 卡顿                                                            */
/* ------------------------------------------------------------------ */

export function analyzeJank(input) {
  const options = primitiveInput(input, 'analyzeJank');
  const budget = options.budget ?? null;
  if (budget) budget.check();
  // jank 只读时间戳：不要求 image、不因 JPEG 解码失败而失败（U-DV12）。
  const frames = normalizeAnalysisFrames(options.frames, { materialize: false });
  const thresholds = resolveThresholds('jank', options.thresholds);
  if (options.intervalFactor !== undefined) {
    thresholds.intervalFactor = readNumber(options, 'intervalFactor', 'jank', { min: 1, max: 10, required: true });
  }
  const expectedIntervalMs = options.expectedIntervalMs;
  if (typeof expectedIntervalMs !== 'number' || !Number.isFinite(expectedIntervalMs) || expectedIntervalMs <= 0) {
    badArgument('expectedIntervalMs', 'must-be-a-positive-finite-number', 'jank');
  }
  const gap = sequenceGap(frames);
  if (frames.length < 2) {
    return buildMotionResult('jank', frames, {
      verdict: 'INCONCLUSIVE',
      reasons: ['insufficient-samples'],
      resolvedThresholds: thresholds,
      metrics: { expectedIntervalMs, intervals: [] },
    });
  }
  const timeInfo = frameTimes(frames);
  if (timeInfo.times === null) {
    return buildMotionResult('jank', frames, {
      verdict: 'INCONCLUSIVE',
      reasons: ['missing-time'],
      limitations: ['intervals-unverifiable'],
      resolvedThresholds: thresholds,
      metrics: { expectedIntervalMs, intervals: [] },
    });
  }
  const limitMs = expectedIntervalMs * thresholds.intervalFactor;
  const intervals = [];
  for (let index = 1; index < frames.length; index += 1) {
    if (budget) budget.check();
    const left = frames[index - 1];
    const right = frames[index];
    const intervalMs = timeInfo.times[index] - timeInfo.times[index - 1];
    const seqDelta = Number.isInteger(left.seq) && Number.isInteger(right.seq)
      ? right.seq - left.seq
      : null;
    const suspected = intervalMs > limitMs;
    intervals.push({
      fromFrameId: left.frameId,
      toFrameId: right.frameId,
      intervalMs,
      ratioToExpected: intervalMs / expectedIntervalMs,
      suspected,
      cause: suspected ? (seqDelta !== null && seqDelta > 1 ? 'capture-gap' : 'page-or-host') : null,
    });
  }
  const suspectedIntervals = intervals.filter((interval) => interval.suspected);
  const captureOnly = suspectedIntervals.length > 0
    && suspectedIntervals.every((interval) => interval.cause === 'capture-gap');
  const integrity = options.integrity;
  if (integrity !== undefined && integrity !== null && !isPlainObject(integrity)) {
    badArgument('integrity', 'not-an-object', 'jank');
  }
  const limitations = [];
  if (timeInfo.source === 'received') limitations.push('intervals-from-received-mono');
  if (gap.hasGap) limitations.push('missing-intermediate-frames');
  if (integrity && (integrity.ackFailures > 0 || integrity.dropped > 0 || integrity.evicted > 0)) {
    limitations.push('capture-loss-present');
  }
  const durations = intervals.map((interval) => interval.intervalMs);
  const metrics = {
    expectedIntervalMs,
    intervalFactor: thresholds.intervalFactor,
    limitMs,
    intervals,
    suspectedCount: suspectedIntervals.length,
    p50: percentile(durations, 50),
    p95: percentile(durations, 95),
    max: durations.length > 0 ? Math.max(...durations) : null,
    min: durations.length > 0 ? Math.min(...durations) : null,
    mean: durations.length > 0 ? durations.reduce((sum, value) => sum + value, 0) / durations.length : null,
    sequenceUnknown: gap.unknown,
  };
  if (suspectedIntervals.length > 0) {
    if (captureOnly) {
      return buildMotionResult('jank', frames, {
        verdict: 'WARN',
        reasons: ['capture-jitter-only'],
        limitations: [...limitations, 'suspected-intervals-coincide-with-missing-frames'],
        resolvedThresholds: thresholds,
        metrics,
      });
    }
    return buildMotionResult('jank', frames, {
      verdict: 'FAIL',
      reasons: ['jank-detected'],
      limitations,
      resolvedThresholds: thresholds,
      metrics,
    });
  }
  if (gap.hasGap || (integrity && integrity.complete === false)) {
    return buildMotionResult('jank', frames, {
      verdict: 'INCONCLUSIVE',
      reasons: [gap.hasGap ? 'missing-intermediate-frames' : 'integrity-incomplete'],
      limitations,
      resolvedThresholds: thresholds,
      metrics,
    });
  }
  return buildMotionResult('jank', frames, {
    verdict: 'PASS',
    reasons: ['no-jank'],
    limitations,
    resolvedThresholds: thresholds,
    metrics,
  });
}

/* ------------------------------------------------------------------ */
/* 6) 轨迹                                                            */
/* ------------------------------------------------------------------ */

function validateTrajectoryQuery(query) {
  if (!isPlainObject(query)) badArgument('query', query === undefined ? 'missing-required-field' : 'not-an-object', 'trajectory');
  if (!hasOwn(MOTION_QUERY_VARIANTS, query.method)) badArgument('method', 'invalid-enum', 'trajectory.query');
  const variant = MOTION_QUERY_VARIANTS[query.method];
  assertAllowedKeys(query, variant.allowed, 'trajectory.query');
  const normalized = { method: variant.method };
  if (variant.method === 'color') {
    const colorSpec = variant.fields.color;
    const color = query.color;
    if (!Array.isArray(color) || color.length !== colorSpec.channels) badArgument('color', 'invalid-rgb', 'trajectory.query');
    for (const channel of color) {
      if (!Number.isInteger(channel) || channel < colorSpec.min || channel > colorSpec.max) {
        badArgument('color', 'invalid-rgb-channel', 'trajectory.query');
      }
    }
    normalized.color = [...color];
  } else {
    const productIdSpec = variant.fields.productId;
    const productId = readString(query, 'productId', 'trajectory.query', {
      required: true, maxBytes: productIdSpec.maxBytes,
    });
    if (!new RegExp(productIdSpec.pattern).test(productId)) {
      badArgument('productId', 'invalid-product-id', 'trajectory.query');
    }
    normalized.productId = productId;
  }
  for (const key of Object.keys(variant.fields)) {
    if (key === 'color' || key === 'productId') continue;
    const spec = variant.fields[key];
    normalized[key] = readNumber(query, key, 'trajectory.query', {
      min: spec.min, max: spec.max, integer: spec.integer === true, fallback: spec.default,
    });
  }
  return normalized;
}

export function analyzeTrajectory(input) {
  const options = primitiveInput(input, 'analyzeTrajectory');
  const budget = options.budget ?? null;
  if (budget) budget.check();
  const frames = normalizeAnalysisFrames(options.frames);
  const thresholds = resolveThresholds('trajectory', options.thresholds);
  const query = validateTrajectoryQuery(options.query);
  let region = null;
  if (options.region !== undefined && options.region !== null) {
    try {
      region = validatePixelRect(options.region, 'region');
    } catch (error) {
      throw convertVisionArgument(error, 'region');
    }
    const dims = firstImageDimensions(frames);
    if (dims && (region.x + region.width > dims.width || region.y + region.height > dims.height)) {
      badArgument('region', 'out-of-bounds', 'analyze');
    }
  }
  const gap = sequenceGap(frames);
  const limitations = [];
  if (gap.hasGap) limitations.push('missing-intermediate-frames');
  if (gap.unknown) limitations.push('sequence-unknown');
  if (frames.length < 2) {
    return buildMotionResult('trajectory', frames, {
      verdict: 'INCONCLUSIVE',
      reasons: ['insufficient-samples'],
      limitations,
      region,
      resolvedThresholds: thresholds,
      metrics: { query, steps: [], frames: [], requiredSamples: 2 },
    });
  }
  let templateImage = null;
  if (query.method === 'template') {
    if (options.templateImage === undefined || options.templateImage === null) {
      return buildMotionResult('trajectory', frames, {
        verdict: 'INCONCLUSIVE',
        reasons: ['template-unavailable'],
        limitations: [...limitations, 'template-product-not-resolved'],
        region,
        resolvedThresholds: thresholds,
        metrics: { query, steps: [], frames: [] },
      });
    }
    try {
      templateImage = validateImage(options.templateImage, 'templateImage');
    } catch (error) {
      throw convertVisionArgument(error, 'templateImage');
    }
  }
  const mappingLimitations = [];
  for (let index = 1; index < frames.length; index += 1) {
    if (frames[index - 1].mapping && frames[index].mapping
      && !mappingCompatible(frames[index - 1].mapping, frames[index].mapping)) {
      mappingLimitations.push(`${frames[index - 1].frameId}->${frames[index].frameId}`);
    }
  }
  if (mappingLimitations.length > 0) {
    return buildMotionResult('trajectory', frames, {
      verdict: 'INCONCLUSIVE',
      reasons: ['mapping-incompatible'],
      classifications: ['mapping-incompatible'],
      limitations,
      region,
      resolvedThresholds: thresholds,
      metrics: { query, steps: [], frames: [], mappingIncompatiblePairs: mappingLimitations },
    });
  }
  const perFrame = [];
  const unresolved = [];
  const steps = [];
  for (const frame of frames) {
    if (budget) budget.check();
    if (!frame.image) {
      perFrame.push({ frameId: frame.frameId, status: 'decoder-unavailable', candidates: [] });
      unresolved.push({ frameId: frame.frameId, reason: 'decoder-unavailable', candidateIds: [] });
      continue;
    }
    let search;
    try {
      search = findInImage(frame.image, query.method === 'template'
        ? { method: 'template', template: { kind: 'product', productId: query.productId }, minScore: query.minScore, stride: query.stride, maxResults: query.maxResults }
        : { method: 'color', color: query.color, tolerance: query.tolerance, minArea: query.minArea, maxResults: query.maxResults },
      {
        roi: region ?? undefined,
        templateImage: templateImage ?? undefined,
      });
    } catch (error) {
      if (error instanceof BrowserError && error.code === 'INVALID_ARGUMENT') {
        throw convertVisionArgument(error, 'query');
      }
      throw error;
    }
    const candidates = search.candidates.map((candidate) => ({
      id: candidate.id,
      region: candidate.region,
      centroid: candidate.centroid,
      area: candidate.area,
      score: candidate.score,
      signal: candidate.signal,
    }));
    if (candidates.length === 1) {
      perFrame.push({
        frameId: frame.frameId,
        status: 'resolved',
        candidateId: candidates[0].id,
        centroid: candidates[0].centroid,
        candidates,
        truncated: search.truncated,
      });
    } else if (candidates.length === 0) {
      perFrame.push({ frameId: frame.frameId, status: 'candidate-missing', candidates });
      unresolved.push({ frameId: frame.frameId, reason: 'candidate-missing', candidateIds: [] });
    } else {
      perFrame.push({
        frameId: frame.frameId,
        status: 'candidate-ambiguous',
        candidates,
        candidateIds: candidates.map((candidate) => candidate.id),
      });
      unresolved.push({
        frameId: frame.frameId,
        reason: 'candidate-ambiguous',
        candidateIds: candidates.map((candidate) => candidate.id),
      });
    }
  }
  for (let index = 1; index < perFrame.length; index += 1) {
    const left = perFrame[index - 1];
    const right = perFrame[index];
    if (left.status !== 'resolved' || right.status !== 'resolved') continue;
    const dx = right.centroid.x - left.centroid.x;
    const dy = right.centroid.y - left.centroid.y;
    const distance = Math.sqrt(dx * dx + dy * dy);
    steps.push({
      fromFrameId: left.frameId,
      toFrameId: right.frameId,
      dx,
      dy,
      distance,
      exceedsMaxStep: distance > thresholds.maxStep,
      fromMapping: frames[index - 1].mapping,
      toMapping: frames[index].mapping,
    });
  }
  const exceeded = steps.filter((step) => step.exceedsMaxStep);
  const metrics = { query, steps, frames: perFrame, unresolved, maxStep: thresholds.maxStep };
  if (exceeded.length > 0) {
    return buildMotionResult('trajectory', frames, {
      verdict: 'FAIL',
      reasons: ['step-exceeded'],
      limitations: [...limitations, 'object-identity-not-proven'],
      region,
      resolvedThresholds: thresholds,
      metrics,
      extra: { unresolved },
    });
  }
  if (unresolved.length > 0) {
    return buildMotionResult('trajectory', frames, {
      verdict: 'INCONCLUSIVE',
      reasons: [...new Set(unresolved.map((item) => item.reason))],
      limitations: [...limitations, 'no-auto-switch-on-ambiguity'],
      region,
      resolvedThresholds: thresholds,
      metrics,
      extra: { unresolved },
    });
  }
  if (steps.length === 0) {
    return buildMotionResult('trajectory', frames, {
      verdict: 'INCONCLUSIVE',
      reasons: ['insufficient-resolved-steps'],
      limitations,
      region,
      resolvedThresholds: thresholds,
      metrics,
      extra: { unresolved },
    });
  }
  return buildMotionResult('trajectory', frames, {
    verdict: 'PASS',
    reasons: ['trajectory-followed'],
    limitations,
    region,
    resolvedThresholds: thresholds,
    metrics,
    extra: { unresolved },
  });
}

/* ------------------------------------------------------------------ */
/* 7) 过渡                                                            */
/* ------------------------------------------------------------------ */

export function analyzeTransition(input) {
  const options = primitiveInput(input, 'analyzeTransition');
  const budget = options.budget ?? null;
  if (budget) budget.check();
  const frames = normalizeAnalysisFrames(options.frames);
  const thresholds = resolveThresholds('transition', options.thresholds);
  const { region, masks } = resolveRegionAndMasks(options, frames);
  const gap = sequenceGap(frames);
  const minimumFrames = thresholds.stableSamples + 2;
  if (frames.length < minimumFrames) {
    return buildMotionResult('transition', frames, {
      verdict: 'INCONCLUSIVE',
      reasons: ['insufficient-samples'],
      limitations: ['needs-stable-samples-plus-onset'],
      region,
      masks,
      resolvedThresholds: thresholds,
      metrics: { pairs: [], requiredSamples: minimumFrames },
    });
  }
  const timeInfo = frameTimes(frames);
  const times = timeInfo.times;
  const pairs = [];
  const errors = [];
  for (let index = 1; index < frames.length; index += 1) {
    if (budget) budget.check();
    const left = frames[index - 1];
    const right = frames[index];
    const diff = diffPair(left, right, { region, masks, pixelThreshold: thresholds.pixelThreshold });
    if (diff.error) {
      errors.push({ code: diff.error, fromFrameId: left.frameId, toFrameId: right.frameId });
      pairs.push(null);
      continue;
    }
    pairs.push({
      fromFrameId: left.frameId,
      toFrameId: right.frameId,
      diffRatio: diff.diffRatio,
      changed: diff.diffRatio > thresholds.changeRatio,
      stable: diff.diffRatio <= thresholds.stableRatio,
    });
  }
  const limitations = [];
  if (gap.hasGap) limitations.push('missing-intermediate-frames');
  if (gap.unknown) limitations.push('sequence-unknown');
  if (timeInfo.source === 'received') limitations.push('duration-from-received-mono');
  const metrics = { pairs, errors, stableSamples: thresholds.stableSamples, transition: null };

  let onset = -1;
  for (let index = 0; index < pairs.length; index += 1) {
    if (pairs[index] && pairs[index].changed) {
      onset = index;
      break;
    }
  }
  if (onset === -1) {
    if (errors.length > 0) return pairErrorVerdict('transition', frames, errors, gap);
    if (gap.hasGap) {
      return buildMotionResult('transition', frames, {
        verdict: 'INCONCLUSIVE',
        reasons: ['missing-intermediate-frames'],
        limitations,
        region,
        masks,
        resolvedThresholds: thresholds,
        metrics,
      });
    }
    return buildMotionResult('transition', frames, {
      verdict: 'INCONCLUSIVE',
      reasons: ['no-transition'],
      limitations,
      region,
      masks,
      resolvedThresholds: thresholds,
      metrics,
    });
  }
  let stableRun = 0;
  let endPair = null;
  for (let index = onset + 1; index < pairs.length; index += 1) {
    if (!pairs[index]) break;
    if (pairs[index].stable) {
      stableRun += 1;
      if (stableRun >= thresholds.stableSamples) {
        endPair = index;
        break;
      }
    } else {
      stableRun = 0;
    }
  }
  if (endPair === null) {
    return buildMotionResult('transition', frames, {
      verdict: 'INCONCLUSIVE',
      reasons: ['stability-not-reached'],
      limitations: [...limitations, `stable-samples:${stableRun}/${thresholds.stableSamples}`],
      region,
      masks,
      resolvedThresholds: thresholds,
      metrics,
      extra: { transition: { onsetPairIndex: onset, completed: false } },
    });
  }
  const startFrame = frames[onset];
  const changedFrame = frames[onset + 1];
  const endFrame = frames[endPair + 1];
  const transition = {
    onsetPairIndex: onset,
    onsetFromFrameId: startFrame.frameId,
    onsetToFrameId: changedFrame.frameId,
    stableStartPairIndex: onset + 1,
    completed: true,
    samplingInterval: {
      fromFrameId: startFrame.frameId,
      toFrameId: endFrame.frameId,
      fromMs: times === null ? null : times[onset],
      toMs: times === null ? null : times[endPair + 1],
      durationMs: times === null ? null : times[endPair + 1] - times[onset],
      stableSamples: thresholds.stableSamples,
    },
    uncertaintyMs: null,
  };
  metrics.transition = transition;
  if (!framesPrecision(frames).precise) {
    return buildMotionResult('transition', frames, {
      verdict: 'INCONCLUSIVE',
      reasons: ['jpeg-non-precise'],
      limitations: [...limitations, 'jpeg-stability-not-precise'],
      region,
      masks,
      resolvedThresholds: thresholds,
      metrics,
      extra: { transition },
    });
  }
  return buildMotionResult('transition', frames, {
    verdict: 'PASS',
    reasons: ['transition-observed'],
    limitations: [...limitations, 'sampling-endpoint-not-business-completion'],
    region,
    masks,
    resolvedThresholds: thresholds,
    metrics,
    extra: { transition },
  });
}

/* ------------------------------------------------------------------ */
/* 断言校验与批量执行                                                  */
/* ------------------------------------------------------------------ */

const ASSERTION_KEYS = Object.freeze([
  'id', 'type', 'region', 'masks', 'thresholds', 'expectedIntervalMs', 'query', 'expectation',
]);

function validateWindow(value, label) {
  if (!isPlainObject(value)) badArgument('window', 'not-an-object', label);
  assertAllowedKeys(value, ['fromMs', 'toMs'], label);
  const fromMs = readNumber(value, 'fromMs', label, { required: true });
  const toMs = readNumber(value, 'toMs', label, { required: true });
  if (fromMs > toMs) badArgument('window', 'from-greater-than-to', label);
  return { fromMs, toMs };
}

export function validateMotionAssertions(assertions) {
  if (!Array.isArray(assertions)) badArgument('assertions', 'not-an-array', 'assertions');
  if (assertions.length === 0) badArgument('assertions', 'empty-array', 'assertions');
  if (assertions.length > T4_LIMITS.maxAssertions) {
    throw new BrowserError('DYNAMIC_LIMIT_EXCEEDED', 'too many assertions', {
      limit: 'maxAssertions', actual: assertions.length, max: T4_LIMITS.maxAssertions,
    });
  }
  const seen = new Set();
  return assertions.map((item, index) => {
    const label = `assertions[${index}]`;
    if (!isPlainObject(item)) badArgument(label, 'not-an-object', 'assertions');
    assertAllowedKeys(item, ASSERTION_KEYS, label);
    const id = readString(item, 'id', label, { required: true, maxBytes: 64 });
    if (seen.has(id)) badArgument('id', 'duplicate-id', label);
    seen.add(id);
    if (!hasOwn(item, 'type')) badArgument('type', 'missing-required-field', label);
    const type = item.type;
    if (!MOTION_TYPES.includes(type)) badArgument('type', 'invalid-enum', label);
    let region = null;
    if (hasOwn(item, 'region')) {
      if (item.region === null) badArgument('region', 'null-not-allowed', label);
      try {
        region = validatePixelRect(item.region, `${label}.region`);
      } catch (error) {
        throw convertVisionArgument(error, 'region');
      }
    }
    let masks = [];
    if (hasOwn(item, 'masks')) {
      if (item.masks === null) badArgument('masks', 'null-not-allowed', label);
      try {
        masks = validateMasks(item.masks, `${label}.masks`);
      } catch (error) {
        throw convertVisionArgument(error, 'masks');
      }
    }
    const thresholds = resolveThresholds(type, item.thresholds);
    // 条件字段规则与 MOTION_ASSERTION_SCHEMA 同源（MOTION_TYPE_RULES）：
    // 只允许该类型的额外字段出现，且 null 一律拒绝。
    const conditional = MOTION_TYPE_RULES[type].conditional;
    for (const key of MOTION_CONDITIONAL_FIELDS) {
      if (!hasOwn(item, key)) continue;
      if (!conditional.includes(key)) badArgument(key, 'not-applicable-for-type', label);
      if (item[key] === null) badArgument(key, 'null-not-allowed', label);
    }
    let expectedIntervalMs = null;
    if (hasOwn(item, 'expectedIntervalMs')) {
      expectedIntervalMs = readNumber(item, 'expectedIntervalMs', label, { required: true });
      if (!(expectedIntervalMs > 0)) badArgument('expectedIntervalMs', 'must-be-positive', label);
    }
    let query = null;
    if (hasOwn(item, 'query')) query = validateTrajectoryQuery(item.query);
    let expectation = null;
    if (type === 'freeze') {
      if (!hasOwn(item, 'expectation')) badArgument('expectation', 'missing-required-field', label);
      expectation = validateFreezeExpectation(item.expectation);
    }
    for (const key of MOTION_TYPE_RULES[type].required) {
      if (key === 'expectation') continue; // 已在上面按 freeze 规则校验
      if (!hasOwn(item, key)) badArgument(key, 'missing-required-field', label);
    }
    const normalized = { id, type, region, masks, thresholds };
    if (type === 'freeze') normalized.expectation = expectation;
    if (type === 'jank') normalized.expectedIntervalMs = expectedIntervalMs;
    if (type === 'trajectory') normalized.query = query;
    return normalized;
  });
}

function blockedResult(type, frames, reason) {
  return buildMotionResult(type, frames, {
    verdict: 'BLOCKED',
    reasons: [reason],
    limitations: ['no-valid-frames'],
    metrics: { validFrames: 0 },
  });
}

function analyzeIntegritySnapshot(frames, integrity) {
  if (integrity !== undefined && integrity !== null) {
    if (!isPlainObject(integrity)) badArgument('integrity', 'not-an-object', 'runMotionAssertions');
    return cloneJson(integrity);
  }
  return {
    complete: false,
    captured: null,
    retained: frames.length,
    dropped: null,
    evicted: null,
    truncated: false,
    ackFailures: null,
    gaps: [],
    issues: [{ code: 'integrity-not-provided' }],
    coverage: {
      source: {},
      segments: [],
      maxAdjacentIntervalMs: null,
      missingSourceTimestamps: frames.filter((frame) => !Number.isFinite(frame.sourceTimestamp)).length,
      samplingFailures: null,
      decodeFailures: null,
      adapters: [],
      unknownSourceDrops: null,
    },
  };
}

function prepareAssertionRun(input) {
  if (!isPlainObject(input)) badArgument('input', 'not-an-object', 'runMotionAssertions');
  assertAllowedKeys(input, [
    'frames', 'assertions', 'window', 'frameIds', 'events', 'clockAnchor', 'integrity',
    'limits', 'signal', 'templates', 'templateImage', 'scopeId', 'dynamicSessionId',
  ], 'runMotionAssertions');
  if (input.signal && input.signal.aborted) throw new BrowserError('ABORTED', '分析已取消');
  const assertions = validateMotionAssertions(input.assertions);
  const needPixels = assertions.some((assertion) => assertion.type !== 'jank');
  const frames = normalizeAnalysisFrames(input.frames, { materialize: needPixels });
  if (input.window !== undefined && input.window !== null && input.frameIds !== undefined && input.frameIds !== null) {
    badArgument('frameIds', 'window-and-frameIds-exclusive', 'runMotionAssertions');
  }
  let selected = frames;
  if (input.frameIds !== undefined && input.frameIds !== null) {
    const frameIds = input.frameIds;
    if (!Array.isArray(frameIds) || frameIds.length === 0) badArgument('frameIds', 'must-be-non-empty-array', 'runMotionAssertions');
    if (frameIds.length > T4_LIMITS.maxIds) badArgument('frameIds', 'too-many-items', 'runMotionAssertions');
    const byId = new Map(frames.map((frame) => [frame.frameId, frame]));
    const seenIds = new Set();
    selected = frameIds.map((frameId) => {
      if (typeof frameId !== 'string' || frameId.length === 0) badArgument('frameIds', 'invalid-id', 'runMotionAssertions');
      if (seenIds.has(frameId)) badArgument('frameIds', 'duplicate-id', 'runMotionAssertions');
      seenIds.add(frameId);
      const frame = byId.get(frameId);
      if (!frame) throw notFound('frame', frameId);
      return frame;
    });
  } else if (input.window !== undefined && input.window !== null) {
    const window = validateWindow(input.window, 'runMotionAssertions.window');
    selected = frames.filter((frame) => Number.isFinite(frame.timelineMs)
      && frame.timelineMs >= window.fromMs && frame.timelineMs <= window.toMs);
  }
  const clockAnchor = input.clockAnchor === undefined || input.clockAnchor === null ? null : input.clockAnchor;
  if (clockAnchor !== null && !isPlainObject(clockAnchor)) badArgument('clockAnchor', 'not-an-object', 'runMotionAssertions');
  const clockUncertain = clockAnchor !== null && isClockUncertain(clockAnchor);
  const templates = input.templates !== undefined && input.templates !== null && isPlainObject(input.templates)
    ? input.templates
    : null;
  let budgetMs = T4_LIMITS.algorithmBudgetMs;
  if (input.limits !== undefined && input.limits !== null) {
    if (!isPlainObject(input.limits)) badArgument('limits', 'not-an-object', 'runMotionAssertions');
    budgetMs = readNumber(input.limits, 'algorithmBudgetMs', 'runMotionAssertions.limits', {
      min: 1, max: 600000, integer: true, fallback: T4_LIMITS.algorithmBudgetMs,
    });
  }
  const budget = createOperationBudget({ signal: input.signal ?? null, budgetMs });
  const integritySnapshot = analyzeIntegritySnapshot(selected, input.integrity);
  return {
    assertions, selected, clockUncertain, templates, integritySnapshot, budget, input,
  };
}

function dispatchAssertion(assertion, selected, input, budget, clockUncertain) {
  const type = assertion.type;
  let result;
  if (selected.length === 0) {
    result = blockedResult(type, selected, 'no-frames');
  } else if (type === 'frame-diff' || type === 'region-change' || type === 'flicker' || type === 'transition') {
    const analyze = type === 'frame-diff'
      ? analyzeFrameDiff
      : type === 'region-change'
        ? analyzeRegionChange
        : type === 'flicker'
          ? analyzeFlicker
          : analyzeTransition;
    result = analyze({
      frames: selected,
      region: assertion.region,
      masks: assertion.masks,
      thresholds: assertion.thresholds,
      signal: input.signal,
      budget,
    });
  } else if (type === 'freeze') {
    result = analyzeFreeze({
      frames: selected,
      region: assertion.region,
      masks: assertion.masks,
      thresholds: assertion.thresholds,
      expectation: assertion.expectation,
      events: input.events,
      signal: input.signal,
      budget,
    });
  } else if (type === 'jank') {
    result = analyzeJank({
      frames: selected,
      expectedIntervalMs: assertion.expectedIntervalMs,
      intervalFactor: assertion.thresholds.intervalFactor,
      integrity: input.integrity,
      signal: input.signal,
      budget,
    });
  } else {
    const templateImage = input.templates && assertion.query.method === 'template'
      ? (input.templates[assertion.query.productId] ?? input.templateImage ?? null)
      : (input.templateImage ?? null);
    result = analyzeTrajectory({
      frames: selected,
      query: assertion.query,
      region: assertion.region,
      thresholds: assertion.thresholds,
      templateImage,
      signal: input.signal,
      budget,
    });
  }
  let annotated = { id: assertion.id, ...result };
  if (input.signal) {
    annotated = {
      ...annotated,
      limitations: [...new Set([...annotated.limitations, 'sync-variant-checks-at-pair-boundaries'])],
    };
  }
  if (input.templates || input.templateImage) {
    // Host 解析的模板图像是内核交接参数，不是公共 schema 字段。
    annotated = {
      ...annotated,
      limitations: [...new Set([...annotated.limitations, 'template-image-host-resolved'])],
    };
  }
  if (clockUncertain && !annotated.classifications.includes('clock-uncertain')) {
    annotated = {
      ...annotated,
      classifications: [...annotated.classifications, 'clock-uncertain'],
      limitations: [...new Set([...annotated.limitations, 'clock-uncertain'])],
    };
  }
  if (clockUncertain && (type === 'flicker' || type === 'freeze' || type === 'jank' || type === 'transition')
    && annotated.verdict !== 'INCONCLUSIVE' && annotated.verdict !== 'BLOCKED') {
    annotated = {
      ...annotated,
      ok: false,
      status: 'inconclusive',
      verdict: 'INCONCLUSIVE',
      reasons: [...new Set([...annotated.reasons, 'clock-uncertain'])],
      limitations: [...new Set([...annotated.limitations, 'clock-uncertainty-exceeds-10ms'])],
      classifications: [...new Set([...annotated.classifications, 'clock-uncertain'])],
    };
  }
  return annotated;
}

function budgetBlockedAssertion(assertion, kind) {
  return {
    id: assertion.id,
    ...blockedResult(assertion.type, [], kind === 'timeout' ? 'dynamic-timeout' : 'aborted'),
    limitations: ['budget-exhausted', 'remaining-assertions-not-run'],
    classifications: [kind === 'timeout' ? 'dynamic-timeout' : 'aborted'],
  };
}

function finalizeAssertionRun(prepared, results, failureKind, asyncScheduling) {
  const summary = { total: results.length, pass: 0, warn: 0, fail: 0, inconclusive: 0, blocked: 0 };
  for (const result of results) {
    if (result.verdict === 'PASS') summary.pass += 1;
    else if (result.verdict === 'WARN') summary.warn += 1;
    else if (result.verdict === 'FAIL') summary.fail += 1;
    else if (result.verdict === 'BLOCKED') summary.blocked += 1;
    else summary.inconclusive += 1;
  }
  const verdict = aggregateVerdict(results.map((result) => result.verdict));
  const exitCode = verdictToExitCode(verdict);
  return {
    ok: exitCode === 0,
    results,
    summary,
    verdict,
    exitCode,
    integrity: prepared.integritySnapshot,
    algorithmVersion: T4_ALGORITHM_VERSION,
    timedOut: failureKind === 'timeout',
    aborted: failureKind === 'aborted',
    scheduling: asyncScheduling ? 'between-assertions' : 'synchronous',
  };
}

export function runMotionAssertions(input = {}) {
  const prepared = prepareAssertionRun(input);
  const { assertions, selected, input: request } = prepared;
  const results = [];
  let failureKind = null;
  for (let index = 0; index < assertions.length; index += 1) {
    try {
      results.push(dispatchAssertion(assertions[index], selected, request, prepared.budget, prepared.clockUncertain));
    } catch (error) {
      if (error && error.budgetKind) {
        failureKind = error.budgetKind;
        for (let rest = index; rest < assertions.length; rest += 1) {
          results.push(budgetBlockedAssertion(assertions[rest], failureKind));
        }
        break;
      }
      throw error;
    }
  }
  return finalizeAssertionRun(prepared, results, failureKind, false);
}

/**
 * 异步变体：在断言边界让出事件循环（`setImmediate`），共用同一累计预算与 signal。
 * 原语内部仍为同步实现（重活由 T3 diffImages 自带的取消/预算检查兜底），
 * 因此结果会带 `sync-variant-checks-at-pair-boundaries` 限制，不假装逐像素可取消。
 */
export async function runMotionAssertionsAsync(input = {}) {
  const prepared = prepareAssertionRun(input);
  const { assertions, selected, input: request } = prepared;
  const results = [];
  let failureKind = null;
  for (let index = 0; index < assertions.length; index += 1) {
    await new Promise((resolve) => setImmediate(resolve));
    try {
      results.push(dispatchAssertion(assertions[index], selected, request, prepared.budget, prepared.clockUncertain));
    } catch (error) {
      if (error && error.budgetKind) {
        failureKind = error.budgetKind;
        for (let rest = index; rest < assertions.length; rest += 1) {
          results.push(budgetBlockedAssertion(assertions[rest], failureKind));
        }
        break;
      }
      throw error;
    }
  }
  return finalizeAssertionRun(prepared, results, failureKind, true);
}

/* ------------------------------------------------------------------ */
/* 动态事件关联 DC                                                     */
/* ------------------------------------------------------------------ */

const SOURCE_DOMAINS = Object.freeze(['operation', 'visual', 'network']);
const JOIN_KIND = Object.freeze({
  actionOp: 'action-op',
  opRequest: 'op-request',
  requestHop: 'request-hop',
  trace: 'trace',
  object: 'object',
  transitionParent: 'transition-parent',
});

export function encodeCorrelationCursor(descriptor) {
  if (!isPlainObject(descriptor)) badArgument('descriptor', 'not-an-object', 'encodeCorrelationCursor');
  assertLossless(descriptor, 'correlationCursor');
  return encodeCursor({ v: 1, ...descriptor });
}

export function decodeCorrelationCursor(cursor) {
  if (typeof cursor !== 'string' || cursor.length === 0) badArgument('cursor', 'not-a-string', 'decodeCorrelationCursor');
  if (Buffer.byteLength(cursor, 'utf8') > 2048) badArgument('cursor', 'string-too-long', 'decodeCorrelationCursor');
  const parsed = decodeCursor(cursor, 'correlationCursor');
  if (parsed.v !== 1) badArgument('cursor', 'unsupported-cursor-version', 'decodeCorrelationCursor');
  if (typeof parsed.dynamicSessionId !== 'string' || parsed.dynamicSessionId.length === 0) {
    badArgument('cursor', 'invalid-cursor', 'decodeCorrelationCursor');
  }
  if (!Number.isInteger(parsed.offset) || parsed.offset < 0) {
    badArgument('cursor', 'invalid-cursor-offset', 'decodeCorrelationCursor');
  }
  if (typeof parsed.fingerprint !== 'string' || parsed.fingerprint.length === 0) {
    badArgument('cursor', 'invalid-cursor-fingerprint', 'decodeCorrelationCursor');
  }
  if (!isPlainObject(parsed.highWater)) badArgument('cursor', 'invalid-cursor-highwater', 'decodeCorrelationCursor');
  return parsed;
}

function normalizeSnapshot(snapshot, domain) {
  if (snapshot === undefined || snapshot === null) return null;
  if (!isPlainObject(snapshot)) badArgument(`sources.${domain}`, 'not-an-object', 'correlate');
  assertAllowedKeys(snapshot, ['events', 'integrity', 'highWater'], `sources.${domain}`);
  const events = snapshot.events === undefined ? [] : snapshot.events;
  if (!Array.isArray(events)) badArgument(`sources.${domain}.events`, 'not-an-array', 'correlate');
  if (events.length > T4_LIMITS.maxEventsHard) {
    throw new BrowserError('DYNAMIC_LIMIT_EXCEEDED', 'source snapshot too large', {
      limit: 'maxEventsHard', actual: events.length, max: T4_LIMITS.maxEventsHard,
    });
  }
  const highWater = snapshot.highWater === undefined || snapshot.highWater === null
    ? null
    : readNumber(snapshot, 'highWater', `sources.${domain}`, { min: 0, integer: true, required: true });
  let integrity = null;
  if (snapshot.integrity !== undefined && snapshot.integrity !== null) {
    if (!isPlainObject(snapshot.integrity)) badArgument(`sources.${domain}.integrity`, 'not-an-object', 'correlate');
    assertLossless(snapshot.integrity, `sources.${domain}.integrity`);
    integrity = cloneJson(snapshot.integrity);
  }
  return { events: [...events], integrity, highWater };
}

function normalizeCorrelationSources(sources) {
  if (sources === undefined || sources === null) {
    return { operation: null, visual: null, network: null };
  }
  if (!isPlainObject(sources)) badArgument('sources', 'not-an-object', 'correlate');
  assertAllowedKeys(sources, [...SOURCE_DOMAINS], 'sources');
  return {
    operation: normalizeSnapshot(sources.operation, 'operation'),
    visual: normalizeSnapshot(sources.visual, 'visual'),
    network: normalizeSnapshot(sources.network, 'network'),
  };
}

export function validateCorrelationInput(input = {}) {
  if (!isPlainObject(input)) badArgument('input', 'not-an-object', 'correlate');
  assertAllowedKeys(input, [
    'dynamicSessionId', 'scopeId', 'window', 'directions', 'eventIds', 'sources',
    'includeTemporal', 'beforeMs', 'afterMs', 'limit', 'cursor',
  ], 'correlate');
  const dynamicSessionId = readString(input, 'dynamicSessionId', 'correlate', { required: true, maxBytes: 128 });
  const scopeId = readNullableString(input, 'scopeId', 'correlate', { maxBytes: 128 });
  let window = null;
  if (hasOwn(input, 'window')) {
    if (input.window === null) badArgument('window', 'null-not-allowed', 'correlate');
    window = validateWindow(input.window, 'correlate.window');
  }
  let directions = null;
  if (hasOwn(input, 'directions')) {
    if (!Array.isArray(input.directions) || input.directions.length === 0) {
      badArgument('directions', 'must-be-non-empty-array', 'correlate');
    }
    if (input.directions.length > DC_DIRECTIONS.length) badArgument('directions', 'too-many-items', 'correlate');
    const seenDirections = new Set();
    for (const direction of input.directions) {
      if (!DC_DIRECTIONS.includes(direction)) badArgument('directions', 'invalid-enum', 'correlate');
      if (seenDirections.has(direction)) badArgument('directions', 'duplicate-item', 'correlate');
      seenDirections.add(direction);
    }
    directions = [...input.directions];
  }
  let eventIds = null;
  if (hasOwn(input, 'eventIds')) {
    if (!Array.isArray(input.eventIds) || input.eventIds.length === 0) {
      badArgument('eventIds', 'must-be-non-empty-array', 'correlate');
    }
    if (input.eventIds.length > T4_LIMITS.maxIds) badArgument('eventIds', 'too-many-items', 'correlate');
    const seen = new Set();
    for (const id of input.eventIds) {
      if (typeof id !== 'string' || id.length === 0 || id.length > 128) badArgument('eventIds', 'invalid-id', 'correlate');
      if (seen.has(id)) badArgument('eventIds', 'duplicate-id', 'correlate');
      seen.add(id);
    }
    eventIds = [...input.eventIds];
  }
  const sources = normalizeCorrelationSources(input.sources);
  const includeTemporal = readBoolean(input, 'includeTemporal', 'correlate', false);
  const beforeMs = readNumber(input, 'beforeMs', 'correlate', {
    min: 0, max: T4_LIMITS.maxCorrelationBeforeMs, fallback: T4_LIMITS.correlationBeforeMs,
  });
  const afterMs = readNumber(input, 'afterMs', 'correlate', {
    min: 0, max: T4_LIMITS.maxCorrelationAfterMs, fallback: T4_LIMITS.correlationAfterMs,
  });
  const limit = readNumber(input, 'limit', 'correlate', {
    min: 1, max: 200, integer: true, fallback: 50,
  });
  let cursor = null;
  if (hasOwn(input, 'cursor')) {
    if (input.cursor === null) badArgument('cursor', 'null-not-allowed', 'correlate');
    cursor = decodeCorrelationCursor(input.cursor);
  }
  return {
    dynamicSessionId, scopeId, window, directions, eventIds, sources,
    includeTemporal, beforeMs, afterMs, limit, cursor,
  };
}

function correlationFingerprint(view) {
  const canonical = {
    scopeId: view.scopeId,
    dynamicSessionId: view.dynamicSessionId,
    window: view.window ? { fromMs: view.window.fromMs, toMs: view.window.toMs } : null,
    directions: view.directions,
    eventIds: view.eventIds,
    beforeMs: view.beforeMs,
    afterMs: view.afterMs,
    highWater: view.highWater,
  };
  return sha256Hex(Buffer.from(JSON.stringify(canonical), 'utf8'));
}

function requestKeyString(requestKey) {
  if (!requestKey) return null;
  return [
    requestKey.networkSessionId ?? '',
    requestKey.targetId ?? '',
    requestKey.cdpSessionId ?? '',
    requestKey.requestId,
    Number.isInteger(requestKey.hopId) ? requestKey.hopId : 0,
  ].join('\u0000');
}

function appRequestIdsOf(event) {
  const payload = isPlainObject(event.payload) ? event.payload : {};
  const ids = [];
  if (typeof payload.appRequestId === 'string') ids.push(payload.appRequestId);
  if (Array.isArray(payload.appRequestIds)) {
    for (const id of payload.appRequestIds) if (typeof id === 'string') ids.push(id);
  }
  if (Array.isArray(payload.requestIds)) {
    for (const id of payload.requestIds) if (typeof id === 'string') ids.push(id);
  }
  if (typeof payload.requestId === 'string' && /^t4-req-/.test(payload.requestId)) ids.push(payload.requestId);
  return [...new Set(ids)];
}

function pushMap(map, key, value) {
  if (key === null || key === undefined) return;
  const list = map.get(key);
  if (list) list.push(value);
  else map.set(key, [value]);
}

function hashValue(value) {
  return sha256Hex(Buffer.from(String(value), 'utf8')).slice(0, 32);
}

function joinKey(kind, namespace, value, sourceEventIds) {
  return { kind, valueHash: hashValue(value), namespace, sourceEventIds: [...sourceEventIds] };
}

function directionOf(fromDomain, toDomain) {
  return DC_DIRECTIONS.find((direction) => {
    const [from, to] = DIRECTION_DOMAINS[direction];
    return from === fromDomain && to === toDomain;
  }) ?? null;
}

function crossContextIssue(from, to, basis) {
  if (Number.isInteger(from.runGeneration) && Number.isInteger(to.runGeneration)
    && from.runGeneration !== to.runGeneration) {
    return 'run-generation-mismatch';
  }
  if (from.documentEpoch !== null && to.documentEpoch !== null && from.documentEpoch !== to.documentEpoch) {
    // 显式/协议端点可跨文档（端点本身已证明）；observed/temporal 一律不跨文档合并。
    if (basis === 'observed' || basis === 'temporal') return 'document-epoch-mismatch';
  }
  return null;
}

export function correlateDynamic(input = {}) {
  const view = validateCorrelationInput(input);
  const {
    dynamicSessionId, scopeId, window: queryWindow, beforeMs, afterMs, limit,
  } = view;
  const directions = view.directions ?? [...DC_DIRECTIONS];
  const directionSet = new Set(directions);
  const eventIdFilter = view.eventIds === null ? null : new Set(view.eventIds);
  const unresolved = [];
  const incomplete = [];
  const lateIgnored = { operation: 0, visual: 0, network: 0 };
  const budget = { compares: 0, exhausted: false };
  let truncated = false;

  const domainEvents = { operation: [], visual: [], network: [] };
  const highWater = { operation: null, visual: null, network: null };
  for (const domain of SOURCE_DOMAINS) {
    const snapshot = view.sources[domain];
    if (!snapshot) {
      incomplete.push(`${domain}-not-collected`);
      continue;
    }
    const own = [];
    for (const raw of snapshot.events) {
      const event = normalizeDynamicEvent(raw, {});
      if (event.dynamicSessionId !== null && event.dynamicSessionId !== dynamicSessionId) {
        unresolved.push({
          eventId: event.eventId,
          reason: 'session-mismatch',
          candidateIds: [],
          declaredLink: null,
          evidenceIds: [],
        });
        continue;
      }
      own.push(event);
    }
    let hw = snapshot.highWater;
    if (hw === null) {
      hw = own.reduce((max, event) => (Number.isInteger(event.seq) && event.seq > max ? event.seq : max), 0);
    }
    highWater[domain] = hw;
    for (const event of own) {
      if (Number.isInteger(event.seq) && event.seq > hw) {
        lateIgnored[domain] += 1;
        continue;
      }
      domainEvents[domain].push(event);
    }
    if (lateIgnored[domain] > 0) incomplete.push(`${domain}-late-events-ignored`);
    if (snapshot.integrity && snapshot.integrity.complete === false) incomplete.push(`${domain}-integrity-incomplete`);
  }
  for (const domain of SOURCE_DOMAINS) domainEvents[domain].sort(compareTimelineEvents);

  const fingerprint = correlationFingerprint({ ...view, highWater });
  let offset = 0;
  if (view.cursor) {
    if (view.cursor.fingerprint !== fingerprint) {
      badArgument('cursor', 'cursor-snapshot-mismatch', 'correlate');
    }
    offset = view.cursor.offset;
  }

  let windowFrom = queryWindow ? queryWindow.fromMs : null;
  let windowTo = queryWindow ? queryWindow.toMs : null;
  if (!queryWindow) {
    const times = [];
    for (const domain of SOURCE_DOMAINS) {
      for (const event of domainEvents[domain]) {
        if (Number.isFinite(event.ts.timelineMs)) times.push(event.ts.timelineMs);
      }
    }
    if (times.length > 0) {
      windowFrom = Math.min(...times);
      windowTo = Math.max(...times);
    } else {
      incomplete.push('no-reliable-time-range');
    }
  }
  const endpointAllowed = (event) => eventIdFilter === null || eventIdFilter.has(event.eventId);
  const inWindow = (event) => {
    if (queryWindow === null) return true;
    const time = event.ts.timelineMs;
    return Number.isFinite(time) && time >= queryWindow.fromMs && time <= queryWindow.toMs;
  };

  const ops = domainEvents.operation;
  const visuals = domainEvents.visual;
  const networks = domainEvents.network;
  const allById = new Map();
  for (const domain of SOURCE_DOMAINS) {
    for (const event of domainEvents[domain]) allById.set(event.eventId, event);
  }

  const opsByAction = new Map();
  const opRequestIds = new Map();
  const opIdToNetworks = new Map();
  const appRequestIdToNetworks = new Map();
  const networkByRequestKey = new Map();
  const networkByTrace = new Map();
  const networkByRedirectFrom = new Map();
  const networkByInitiator = new Map();
  const opIdToVisuals = new Map();
  const networkById = new Map();
  const networkByVisualCause = new Map();
  const visualByOpKey = new Map();
  const visualByClock = new Map();

  for (const op of ops) {
    if (op.ids.actionId) pushMap(opsByAction, op.ids.actionId, op);
    if (op.ids.opId) {
      if (Array.isArray(op.payload.requestIds)) {
        const list = opRequestIds.get(op.ids.opId) ?? [];
        for (const id of op.payload.requestIds) if (typeof id === 'string') list.push(id);
        opRequestIds.set(op.ids.opId, [...new Set(list)]);
      }
    }
  }
  for (const network of networks) {
    networkById.set(network.eventId, network);
    if (network.ids.requestKey) pushMap(networkByRequestKey, requestKeyString(network.ids.requestKey), network);
    if (network.ids.traceIdHash) {
      pushMap(networkByTrace, `${network.ids.requestKey?.networkSessionId ?? ''}|${network.ids.traceIdHash}`, network);
    }
    for (const appRequestId of appRequestIdsOf(network)) pushMap(appRequestIdToNetworks, appRequestId, network);
    if (typeof network.payload.opId === 'string') pushMap(opIdToNetworks, network.payload.opId, network);
    const redirectFrom = network.payload.redirectFromRequestKey
      ?? (isPlainObject(network.payload.redirect) ? network.payload.redirect.fromRequestKey : null);
    if (typeof redirectFrom === 'string') pushMap(networkByRedirectFrom, redirectFrom, network);
    if (isPlainObject(network.payload.initiator) && typeof network.payload.initiator.requestKey === 'string') {
      pushMap(networkByInitiator, network.payload.initiator.requestKey, network);
    }
    const causeEventId = typeof network.payload.causeEventId === 'string'
      ? network.payload.causeEventId
      : (typeof network.payload.causeUiEventId === 'string' ? network.payload.causeUiEventId : null);
    if (causeEventId) pushMap(networkByVisualCause, causeEventId, network);
  }
  for (const visual of visuals) {
    const causeOpId = typeof visual.payload.causeOpId === 'string'
      ? visual.payload.causeOpId
      : (visual.ids.opId ?? null);
    if (causeOpId) {
      pushMap(opIdToVisuals, causeOpId, visual);
      pushMap(visualByOpKey, causeOpId, visual);
    }
    if (typeof visual.payload.clockId === 'string') pushMap(visualByClock, visual.payload.clockId, visual);
  }

  const pairBucket = new Map();
  const ambiguityGroups = new Map();
  const addPair = (direction, from, to, options) => {
    if (!directionSet.has(direction)) return false;
    if (!endpointAllowed(from) || !endpointAllowed(to)) return false;
    const {
      basis, confidence, reasons = [], joinKeys = [], evidenceIds = [],
      limitations = [], candidateGroup = null,
    } = options;
    if (!DC_BASIS.includes(basis)) badArgument('basis', 'invalid-enum', 'correlate');
    const compatibility = crossContextIssue(from, to, basis);
    if (compatibility) {
      unresolved.push({
        eventId: from.eventId,
        reason: compatibility,
        candidateIds: [to.eventId],
        declaredLink: null,
        evidenceIds: [],
      });
      return false;
    }
    const key = `${direction}\u0000${from.eventId}\u0000${to.eventId}`;
    const timeDeltaMs = Number.isFinite(from.ts.timelineMs) && Number.isFinite(to.ts.timelineMs)
      ? to.ts.timelineMs - from.ts.timelineMs
      : null;
    const uncertaintyMs = Number.isFinite(from.ts.uncertaintyMs) && Number.isFinite(to.ts.uncertaintyMs)
      ? from.ts.uncertaintyMs + to.ts.uncertaintyMs
      : null;
    const pair = {
      direction,
      fromEventId: from.eventId,
      toEventId: to.eventId,
      basis,
      grade: DC_GRADE_MAP[basis],
      confidence,
      reasons: [...new Set(reasons)],
      joinKeys,
      evidenceIds: [...new Set([from.eventId, to.eventId, ...evidenceIds])],
      provenance: [
        { eventId: from.eventId, ...from.provenance },
        { eventId: to.eventId, ...to.provenance },
      ],
      limitations: [...new Set(limitations)],
      timeDeltaMs,
      uncertaintyMs,
      candidateIds: [to.eventId],
      ambiguous: false,
    };
    const existing = pairBucket.get(key);
    if (existing) {
      if (BASIS_RANK[pair.basis] > BASIS_RANK[existing.basis]) pairBucket.set(key, pair);
      return true;
    }
    pairBucket.set(key, pair);
    if (candidateGroup) {
      const groupKey = `${direction}\u0000${from.eventId}\u0000${candidateGroup}`;
      const group = ambiguityGroups.get(groupKey) ?? [];
      group.push(to.eventId);
      ambiguityGroups.set(groupKey, group);
    }
    return true;
  };

  // 显式声明链接（P0 trace.link / adapter 声明投影为 marker/control 事件的 payload.link）。
  for (const domain of SOURCE_DOMAINS) {
    for (const event of domainEvents[domain]) {
      const link = isPlainObject(event.payload.link) ? event.payload.link : null;
      if (!link) continue;
      const fromId = typeof link.fromEventId === 'string' ? link.fromEventId : null;
      const toId = typeof link.toEventId === 'string' ? link.toEventId : null;
      const from = fromId ? allById.get(fromId) : null;
      const to = toId ? allById.get(toId) : null;
      if (!from || !to) {
        unresolved.push({
          eventId: event.eventId,
          reason: 'declared-link-endpoint-missing',
          candidateIds: [],
          declaredLink: { fromEventId: fromId, toEventId: toId, producer: link.producer ?? event.provenance.producer },
          evidenceIds: [],
        });
        continue;
      }
      const direction = directionOf(from.domain, to.domain);
      if (!direction) {
        unresolved.push({
          eventId: event.eventId,
          reason: 'unsupported-direction',
          candidateIds: [from.eventId, to.eventId],
          declaredLink: { fromEventId: from.eventId, toEventId: to.eventId },
          evidenceIds: [],
        });
        continue;
      }
      const basis = DC_BASIS.includes(link.basis) ? link.basis : 'explicit';
      const declaredLink = {
        fromEventId: from.eventId,
        toEventId: to.eventId,
        basis,
        producer: typeof link.producer === 'string' ? link.producer : event.provenance.producer,
        verified: link.verified === true,
      };
      if (link.verified !== true) {
        unresolved.push({
          eventId: to.eventId,
          reason: 'declared-link-unverified',
          candidateIds: [from.eventId],
          declaredLink,
          evidenceIds: [],
        });
        continue;
      }
      addPair(direction, from, to, {
        basis,
        confidence: 'direct',
        reasons: ['declared-link-verified'],
        joinKeys: [joinKey(JOIN_KIND.transitionParent, 'declared-link', `${from.eventId}>${to.eventId}`, [from.eventId, to.eventId])],
        evidenceIds: Array.isArray(link.evidenceIds) ? link.evidenceIds : [],
        limitations: ['explicit-scope-limited-to-declared-provenance'],
      });
    }
  }

  // operation -> visual
  if (directionSet.has('operation->visual')) {
    for (const op of ops) {
      if (!inWindow(op)) continue;
      const opId = op.ids.opId ?? (typeof op.payload.opId === 'string' ? op.payload.opId : null);
      if (!opId) continue;
      const targets = opIdToVisuals.get(opId) ?? [];
      let matched = 0;
      for (const visual of targets) {
        if (!inWindow(visual)) continue;
        const verified = visual.payload.causeVerified === true && op.provenance.trust === 'host-observed';
        addPair('operation->visual', op, visual, {
          basis: verified ? 'explicit' : 'observed',
          confidence: verified ? 'direct' : 'supported',
          reasons: verified ? ['verified-op-visual-bridge'] : ['page-declared-cause-op'],
          joinKeys: [joinKey(JOIN_KIND.actionOp, 'op-id', opId, [op.eventId, visual.eventId])],
          limitations: verified ? [] : ['page-declared-cause'],
          candidateGroup: 'op-visual',
        });
        matched += 1;
      }
      if (matched === 0 && op.ids.actionId && !opsByAction.has(op.ids.actionId)) {
        unresolved.push({ eventId: op.eventId, reason: 'action-op-bridge-missing', candidateIds: [], declaredLink: null, evidenceIds: [] });
      }
    }
  }

  // operation -> network
  if (directionSet.has('operation->network')) {
    for (const op of ops) {
      if (!inWindow(op)) continue;
      const opId = op.ids.opId ?? null;
      const targets = new Map();
      if (opId) {
        for (const network of opIdToNetworks.get(opId) ?? []) targets.set(network.eventId, network);
        for (const appRequestId of opRequestIds.get(opId) ?? []) {
          for (const network of appRequestIdToNetworks.get(appRequestId) ?? []) targets.set(network.eventId, network);
        }
      }
      if (targets.size === 0) {
        if (op.ids.actionId || opId) {
          unresolved.push({ eventId: op.eventId, reason: 'request-endpoint-missing', candidateIds: [], declaredLink: null, evidenceIds: [] });
        }
        continue;
      }
      for (const network of targets.values()) {
        if (!inWindow(network)) continue;
        const verified = network.payload.headerVerified === true
          && op.provenance.trust === 'host-observed'
          && targets.size === 1;
        addPair('operation->network', op, network, {
          basis: verified ? 'explicit' : 'observed',
          confidence: verified ? 'direct' : 'supported',
          reasons: verified ? ['verified-op-request-bridge'] : ['op-request-shared-id'],
          joinKeys: [joinKey(JOIN_KIND.opRequest, 'app-request-id', appRequestIdsOf(network).join(',') || network.eventId, [op.eventId, network.eventId])],
          limitations: verified ? [] : ['no-header-cross-check'],
          candidateGroup: 'op-request',
        });
      }
    }
  }

  // network -> visual
  if (directionSet.has('network->visual')) {
    for (const visual of visuals) {
      if (!inWindow(visual)) continue;
      const cause = isPlainObject(visual.payload.cause) ? visual.payload.cause : null;
      const candidates = new Map();
      const causeEventId = cause && typeof cause.eventId === 'string'
        ? cause.eventId
        : (typeof visual.payload.causeEventId === 'string' ? visual.payload.causeEventId : null);
      if (causeEventId) {
        const network = networkById.get(causeEventId);
        if (network) candidates.set(network.eventId, network);
      }
      if (cause && typeof cause.requestKey === 'string') {
        for (const network of networkByRequestKey.get(cause.requestKey) ?? []) candidates.set(network.eventId, network);
      }
      if (cause && typeof cause.requestId === 'string') {
        for (const network of appRequestIdToNetworks.get(cause.requestId) ?? []) candidates.set(network.eventId, network);
      }
      if (candidates.size === 0) {
        if (causeEventId || cause) {
          unresolved.push({
            eventId: visual.eventId,
            reason: 'network-cause-missing',
            candidateIds: [],
            declaredLink: cause,
            evidenceIds: [],
          });
        }
        continue;
      }
      for (const network of candidates.values()) {
        if (!inWindow(network)) continue;
        const verified = visual.payload.causeVerified === true && visual.payload.uiTransition === true;
        addPair('network->visual', network, visual, {
          basis: verified ? 'explicit' : 'observed',
          confidence: verified ? 'direct' : 'supported',
          reasons: verified ? ['verified-ui-cause-transition'] : ['page-declared-ui-cause'],
          joinKeys: [joinKey(JOIN_KIND.object, 'network-event', network.eventId, [network.eventId, visual.eventId])],
          limitations: verified ? [] : ['page-declared-cause'],
          candidateGroup: 'network-ui',
        });
      }
    }
  }

  // visual -> network
  if (directionSet.has('visual->network')) {
    for (const network of networks) {
      if (!inWindow(network)) continue;
      const causeIds = [
        network.payload.causeEventId,
        network.payload.causeUiEventId,
        network.payload.retryFromEventId,
      ].filter((id) => typeof id === 'string');
      for (const causeId of causeIds) {
        const from = allById.get(causeId);
        if (!from) {
          unresolved.push({
            eventId: network.eventId,
            reason: 'visual-cause-missing',
            candidateIds: [],
            declaredLink: { causeEventId: causeId },
            evidenceIds: [],
          });
          continue;
        }
        if (from.domain !== 'visual') continue;
        if (!inWindow(from)) continue;
        const verified = network.payload.causeVerified === true && network.payload.chainVerified === true;
        addPair('visual->network', from, network, {
          basis: verified ? 'explicit' : 'observed',
          confidence: verified ? 'direct' : 'supported',
          reasons: verified ? ['verified-visual-network-chain'] : ['ui-state-request-declared'],
          joinKeys: [joinKey(JOIN_KIND.object, 'visual-state', causeId, [from.eventId, network.eventId])],
          limitations: verified ? [] : ['missing-full-parent-bridge'],
          candidateGroup: 'visual-request',
        });
      }
    }
  }

  // network -> network
  if (directionSet.has('network->network')) {
    for (const network of networks) {
      if (!inWindow(network)) continue;
      const redirectFrom = network.payload.redirectFromRequestKey
        ?? (isPlainObject(network.payload.redirect) ? network.payload.redirect.fromRequestKey : null);
      if (typeof redirectFrom === 'string') {
        const parents = (networkByRequestKey.get(redirectFrom) ?? [])
          .filter((candidate) => candidate.eventId !== network.eventId);
        const parent = parents[0] ?? null;
        if (!parent) {
          unresolved.push({
            eventId: network.eventId,
            reason: 'redirect-endpoint-missing',
            candidateIds: [],
            declaredLink: { fromRequestKey: redirectFrom },
            evidenceIds: [],
          });
        } else {
          addPair('network->network', parent, network, {
            basis: 'redirect',
            confidence: 'direct',
            reasons: ['protocol-redirect'],
            joinKeys: [joinKey(JOIN_KIND.requestHop, 'request-key', redirectFrom, [parent.eventId, network.eventId])],
            evidenceIds: [hashValue(redirectFrom)],
            candidateGroup: 'redirect',
          });
        }
      }
      if (isPlainObject(network.payload.initiator)) {
        const initiator = network.payload.initiator;
        if (typeof initiator.requestKey === 'string') {
          const parent = (networkByRequestKey.get(initiator.requestKey) ?? [])
            .filter((candidate) => candidate.eventId !== network.eventId)[0] ?? null;
          if (!parent) {
            unresolved.push({
              eventId: network.eventId,
              reason: 'initiator-endpoint-missing',
              candidateIds: [],
              declaredLink: { requestKey: initiator.requestKey },
              evidenceIds: [],
            });
          } else {
            addPair('network->network', parent, network, {
              basis: 'initiator',
              confidence: 'direct',
              reasons: ['protocol-initiator'],
              joinKeys: [joinKey(JOIN_KIND.requestHop, 'request-key', initiator.requestKey, [parent.eventId, network.eventId])],
              candidateGroup: 'initiator',
            });
          }
        } else {
          // 只有 script 栈不足以建立父边（权威 §5.1）。
          unresolved.push({
            eventId: network.eventId,
            reason: 'initiator-parent-missing',
            candidateIds: [],
            declaredLink: { initiator: { ...initiator } },
            evidenceIds: [],
          });
        }
      }
      if (typeof network.payload.retryFromEventId === 'string') {
        const parent = allById.get(network.payload.retryFromEventId);
        if (!parent || parent.domain !== 'network') {
          unresolved.push({
            eventId: network.eventId,
            reason: 'retry-endpoint-missing',
            candidateIds: [],
            declaredLink: { retryFromEventId: network.payload.retryFromEventId },
            evidenceIds: [],
          });
        } else {
          const verified = network.payload.retryVerified === true;
          addPair('network->network', parent, network, {
            basis: verified ? 'explicit' : 'observed',
            confidence: verified ? 'direct' : 'supported',
            reasons: verified ? ['verified-retry-link'] : ['retry-declared'],
            joinKeys: [joinKey(JOIN_KIND.object, 'retry', parent.eventId, [parent.eventId, network.eventId])],
            limitations: verified ? [] : ['retry-parent-not-verified'],
            candidateGroup: 'retry',
          });
        }
      }
    }
    const byObjectKey = new Map();
    for (const network of networks) {
      for (const appRequestId of appRequestIdsOf(network)) {
        pushMap(byObjectKey, `${network.ids.requestKey?.networkSessionId ?? ''}|app|${appRequestId}`, network);
      }
      if (typeof network.payload.idempotencyKey === 'string') {
        pushMap(byObjectKey, `${network.ids.requestKey?.networkSessionId ?? ''}|idem|${network.payload.idempotencyKey}`, network);
      }
    }
    for (const [groupKey, group] of byObjectKey) {
      const sorted = group.slice().sort((left, right) => {
        const byTime = compareTimelineEvents(left, right);
        return byTime !== 0 ? byTime : (left.seq ?? 0) - (right.seq ?? 0);
      });
      for (let index = 1; index < sorted.length; index += 1) {
        const from = sorted[index - 1];
        const to = sorted[index];
        if (from.eventId === to.eventId) continue;
        if (!inWindow(from) || !inWindow(to)) continue;
        const namespace = groupKey.split('|')[1];
        addPair('network->network', from, to, {
          basis: 'observed',
          confidence: namespace === 'idem' ? 'supported' : 'weak',
          reasons: [namespace === 'idem' ? 'shared-idempotency-key' : 'shared-app-request-id'],
          joinKeys: [joinKey(JOIN_KIND.object, namespace === 'idem' ? 'idempotency-key' : 'app-request-id', groupKey, [from.eventId, to.eventId])],
          limitations: ['group-membership-not-causality'],
          candidateGroup: 'object-group',
        });
      }
    }
    for (const [traceKey, group] of networkByTrace) {
      const sorted = group.slice().sort((left, right) => (left.seq ?? 0) - (right.seq ?? 0));
      for (let index = 1; index < sorted.length; index += 1) {
        const from = sorted[index - 1];
        const to = sorted[index];
        if (!inWindow(from) || !inWindow(to)) continue;
        addPair('network->network', from, to, {
          basis: 'observed',
          confidence: 'weak',
          reasons: ['shared-trace'],
          joinKeys: [joinKey(JOIN_KIND.trace, 'trace', traceKey, [from.eventId, to.eventId])],
          limitations: ['shared-trace-not-causality'],
          candidateGroup: 'trace-group',
        });
      }
    }
  }

  // visual -> visual
  if (directionSet.has('visual->visual')) {
    for (const [opKey, group] of visualByOpKey) {
      const sorted = group.slice().sort(compareTimelineEvents);
      for (let index = 1; index < sorted.length; index += 1) {
        const from = sorted[index - 1];
        const to = sorted[index];
        if (!inWindow(from) || !inWindow(to)) continue;
        addPair('visual->visual', from, to, {
          basis: 'observed',
          confidence: 'supported',
          reasons: ['shared-op'],
          joinKeys: [joinKey(JOIN_KIND.object, 'op-id', opKey, [from.eventId, to.eventId])],
          limitations: ['shared-op-not-causality'],
          candidateGroup: 'visual-op',
        });
      }
    }
    for (const [clockId, group] of visualByClock) {
      const sorted = group.slice().sort(compareTimelineEvents);
      for (let index = 1; index < sorted.length; index += 1) {
        const from = sorted[index - 1];
        const to = sorted[index];
        if (!inWindow(from) || !inWindow(to)) continue;
        addPair('visual->visual', from, to, {
          basis: 'observed',
          confidence: 'weak',
          reasons: ['shared-clock'],
          joinKeys: [joinKey(JOIN_KIND.object, 'clock', clockId, [from.eventId, to.eventId])],
          limitations: ['shared-clock-not-causality'],
          candidateGroup: 'visual-clock',
        });
      }
    }
    for (const visual of visuals) {
      if (typeof visual.payload.parentEventId !== 'string') continue;
      const parent = allById.get(visual.payload.parentEventId);
      if (!parent || parent.domain !== 'visual') {
        unresolved.push({
          eventId: visual.eventId,
          reason: 'visual-parent-missing',
          candidateIds: [],
          declaredLink: { parentEventId: visual.payload.parentEventId },
          evidenceIds: [],
        });
        continue;
      }
      if (visual.payload.parentVerified === true) {
        addPair('visual->visual', parent, visual, {
          basis: 'explicit',
          confidence: 'direct',
          reasons: ['verified-visual-parent'],
          joinKeys: [joinKey(JOIN_KIND.transitionParent, 'visual-event', parent.eventId, [parent.eventId, visual.eventId])],
        });
      } else {
        unresolved.push({
          eventId: visual.eventId,
          reason: 'declared-link-unverified',
          candidateIds: [parent.eventId],
          declaredLink: { fromEventId: parent.eventId, toEventId: visual.eventId, basis: 'explicit' },
          evidenceIds: [],
        });
      }
    }
  }

  // 时间邻近：默认过滤并计 suppressedTemporal；includeTemporal=true 才输出 temporal pair。
  // 同域方向（visual->visual / network->network）先按 |Δt| <= beforeMs+afterMs 预筛，再累加比较预算；
  // 跨域方向保持完整枚举，不因同域预筛丢跨域候选（Lead 2026-11-04 裁决）。
  let suppressedTemporal = 0;
  const temporalCandidates = [];
  const temporalSeen = new Set();
  const directionComparisons = {};
  const sameDomainDirections = [];
  const prefilterWindowMs = beforeMs + afterMs;
  const uncertaintyOf = (event) => (Number.isFinite(event.ts.uncertaintyMs) ? event.ts.uncertaintyMs : 0);
  // 同一对端点在任一方向已有更强关系（observed/explicit/...）时，不再把反向 temporal 计入候选/分页。
  // 纯 temporal 的互反方向仍各自保留（视觉/网络同域邻近本身是无向的，方向只表达域）。
  const strongUnorderedPairs = new Set();
  for (const key of pairBucket.keys()) {
    const [direction, fromId, toId] = key.split('\u0000');
    strongUnorderedPairs.add(`${direction}\u0000${[fromId, toId].sort().join('\u0000')}`);
  }
  const pushTemporalCandidate = (direction, from, to, delta) => {
    const key = `${direction}\u0000${from.eventId}\u0000${to.eventId}`;
    if (temporalSeen.has(key) || pairBucket.has(key)) return;
    const unordered = `${direction}\u0000${[from.eventId, to.eventId].sort().join('\u0000')}`;
    if (strongUnorderedPairs.has(unordered)) return;
    temporalSeen.add(key);
    const overlap = Number.isFinite(from.ts.uncertaintyMs) && Number.isFinite(to.ts.uncertaintyMs)
      && Math.abs(delta) <= from.ts.uncertaintyMs + to.ts.uncertaintyMs;
    temporalCandidates.push({ direction, from, to, overlap });
  };
  const consumeComparison = () => {
    budget.compares += 1;
    if (budget.compares > T4_LIMITS.maxCandidateCompares) {
      budget.exhausted = true;
      truncated = true;
      incomplete.push('candidate-budget-exhausted');
      return false;
    }
    return true;
  };
  for (const direction of directions) {
    if (budget.exhausted) break;
    const [fromDomain, toDomain] = DIRECTION_DOMAINS[direction];
    const fromList = [...domainEvents[fromDomain]].sort(compareTimelineEvents);
    const toList = [...domainEvents[toDomain]].sort(compareTimelineEvents);
    let directionCount = 0;
    if (fromDomain === toDomain) {
      // 同域：时间排序 + 滑动窗口，只有落在候选窗口内的对才消耗比较预算。
      sameDomainDirections.push(direction);
      const list = fromList;
      const count = list.length;
      const times = list.map((item) => (Number.isFinite(item.ts.timelineMs) ? item.ts.timelineMs : null));
      let maxToUncertainty = 0;
      for (const item of list) maxToUncertainty = Math.max(maxToUncertainty, uncertaintyOf(item));
      let lower = 0;
      for (let index = 0; index < count; index += 1) {
        if (budget.exhausted) break;
        const from = list[index];
        const fromTime = times[index];
        if (fromTime === null || !endpointAllowed(from)) continue;
        const coarseSlack = prefilterWindowMs + uncertaintyOf(from) + maxToUncertainty;
        while (lower < count && (times[lower] === null || times[lower] < fromTime - coarseSlack)) lower += 1;
        for (let target = lower; target < count; target += 1) {
          const toTime = times[target];
          if (toTime === null) break;
          if (toTime > fromTime + coarseSlack) break;
          if (target === index) continue;
          const to = list[target];
          if (!endpointAllowed(to)) continue;
          const allowed = consumeComparison();
          directionCount += 1;
          if (!allowed) break;
          const delta = toTime - fromTime;
          if (Math.abs(delta) > prefilterWindowMs + uncertaintyOf(from) + uncertaintyOf(to)) continue;
          pushTemporalCandidate(direction, from, to, delta);
        }
        if (budget.exhausted) break;
      }
    } else {
      // 跨域：保持完整候选枚举（候选窗口仍是非对称 before/after 语义）。
      for (const from of fromList) {
        if (budget.exhausted) break;
        if (!Number.isFinite(from.ts.timelineMs)) continue;
        if (!endpointAllowed(from)) continue;
        for (const to of toList) {
          if (!Number.isFinite(to.ts.timelineMs)) continue;
          if (!endpointAllowed(to)) continue;
          if (from.eventId === to.eventId) continue;
          const allowed = consumeComparison();
          directionCount += 1;
          if (!allowed) break;
          const windowSlack = uncertaintyOf(from) + uncertaintyOf(to);
          const delta = to.ts.timelineMs - from.ts.timelineMs;
          if (delta < -beforeMs - windowSlack || delta > afterMs + windowSlack) continue;
          pushTemporalCandidate(direction, from, to, delta);
        }
        if (budget.exhausted) break;
      }
    }
    directionComparisons[direction] = directionCount;
  }
  if (view.includeTemporal) {
    for (const candidate of temporalCandidates) {
      const reasons = ['window-overlap'];
      if (candidate.overlap) reasons.push('interval-overlap-no-order');
      addPair(candidate.direction, candidate.from, candidate.to, {
        basis: 'temporal',
        confidence: 'weak',
        reasons,
        joinKeys: [],
        limitations: ['temporal-not-causality', ...(candidate.overlap ? ['interval-overlap-no-order'] : [])],
      });
    }
  } else {
    suppressedTemporal = temporalCandidates.length;
  }

  // 候选歧义：同一 (direction, from, joinGroup) 多个同级端点全部保留，不挑“最近的”。
  for (const [groupKey, candidateIds] of ambiguityGroups) {
    if (candidateIds.length <= 1) continue;
    const [direction, fromEventId] = groupKey.split('\u0000');
    for (const toEventId of candidateIds) {
      const key = `${direction}\u0000${fromEventId}\u0000${toEventId}`;
      const pair = pairBucket.get(key);
      if (!pair) continue;
      pair.ambiguous = true;
      pair.candidateIds = [...new Set(candidateIds)];
      pair.confidence = 'unknown';
      pair.reasons = [...new Set([...pair.reasons, 'multiple-candidates'])];
    }
  }

  const orderedPairs = [...pairBucket.values()].sort((left, right) => {
    const byDirection = DC_DIRECTIONS.indexOf(left.direction) - DC_DIRECTIONS.indexOf(right.direction);
    if (byDirection !== 0) return byDirection;
    const byRank = BASIS_RANK[right.basis] - BASIS_RANK[left.basis];
    if (byRank !== 0) return byRank;
    if (left.fromEventId !== right.fromEventId) return left.fromEventId < right.fromEventId ? -1 : 1;
    if (left.toEventId !== right.toEventId) return left.toEventId < right.toEventId ? -1 : 1;
    return 0;
  });
  const pageSlice = orderedPairs.slice(offset, offset + limit);
  const nextOffset = offset + pageSlice.length;
  const pairs = pageSlice.map((pair, index) => ({ id: `p${offset + index + 1}`, ...pair }));
  const cursorNext = nextOffset < orderedPairs.length
    ? encodeCorrelationCursor({
      dynamicSessionId,
      scopeId,
      offset: nextOffset,
      fingerprint,
      highWater,
    })
    : null;

  const dedupedUnresolved = [];
  const unresolvedSeen = new Set();
  for (const item of unresolved) {
    const key = `${item.eventId}\u0000${item.reason}`;
    if (unresolvedSeen.has(key)) continue;
    unresolvedSeen.add(key);
    dedupedUnresolved.push(item);
  }
  if (dedupedUnresolved.length > 0) incomplete.push('unresolved-relations');

  const integrity = {
    operation: view.sources.operation?.integrity ?? null,
    visual: view.sources.visual?.integrity ?? null,
    network: view.sources.network?.integrity ?? null,
    complete: SOURCE_DOMAINS.every((domain) => view.sources[domain] !== null
      && view.sources[domain].integrity !== null
      && view.sources[domain].integrity.complete === true)
      && !truncated
      && incomplete.length === 0,
  };

  const upperBoundPairComparisons = directions.reduce((sum, direction) => {
    const [fromDomain, toDomain] = DIRECTION_DOMAINS[direction];
    const fromCount = domainEvents[fromDomain].length;
    const toCount = domainEvents[toDomain].length;
    return sum + (fromDomain === toDomain ? fromCount * Math.max(0, toCount - 1) : fromCount * toCount);
  }, 0);
  const sameDomainUpperBound = sameDomainDirections.reduce((sum, direction) => {
    const count = domainEvents[DIRECTION_DOMAINS[direction][0]].length;
    return sum + count * Math.max(0, count - 1);
  }, 0);
  const sameDomainComparisons = sameDomainDirections.reduce(
    (sum, direction) => sum + (directionComparisons[direction] ?? 0), 0,
  );

  return {
    version: T4_VERSION,
    algorithmVersion: DC_ALGORITHM_VERSION,
    dynamicSessionId,
    window: { fromMs: windowFrom, toMs: windowTo, beforeMs, afterMs },
    highWater,
    pairs,
    unresolved: dedupedUnresolved,
    suppressedTemporal,
    integrity,
    incomplete: [...new Set(incomplete)],
    truncated,
    cursor: { next: cursorNext },
    verdict: { status: 'INCONCLUSIVE', reason: 'no-assertion' },
    // 真实比较次数（同域预筛后）与上限；Host 的 upper-bound 估算仍可另列，这里是核心实测。
    diagnostics: {
      maxCandidateCompares: T4_LIMITS.maxCandidateCompares,
      pairComparisons: budget.compares,
      estimatedPairComparisons: budget.compares,
      upperBoundPairComparisons,
      directionComparisons,
      sameDomainPrefilter: {
        applied: sameDomainDirections,
        windowMs: prefilterWindowMs,
        skippedPairComparisons: Math.max(0, sameDomainUpperBound - sameDomainComparisons),
      },
      candidateBudgetExhausted: budget.exhausted,
      suppressedTemporal,
      truncated,
    },
  };
}

/**
 * 工具边界投影：meta 中不出现 Buffer/像素（只给 hash、尺寸、字节数与 decode 事实）。
 * Host 用它生成 `browser_motion_observe` 的 FrameMeta，避免把 Buffer 写进 JSON。
 */
export function frameMeta(frame) {
  if (!isPlainObject(frame)) badArgument('frame', 'not-an-object', 'frameMeta');
  const encodedSha256 = frame.encodedSha256 ?? frame.sha256 ?? null;
  return {
    frameId: frame.frameId ?? null,
    seq: Number.isInteger(frame.seq) ? frame.seq : null,
    segmentId: frame.segmentId ?? null,
    source: frame.sourceClock ?? null,
    sourceTimestamp: frame.sourceTimestamp ?? null,
    receivedMonoMs: frame.receivedMonoMs ?? null,
    timelineMs: frame.timelineMs ?? null,
    encoding: frame.encoding ?? null,
    sha256: encodedSha256,
    encodedSha256,
    rgbaSha256: frame.rgbaSha256 ?? null,
    dimensions: frame.dimensions ?? null,
    bytes: Number.isInteger(frame.bytesLength) ? frame.bytesLength : null,
    decode: frame.decode ?? null,
    mapping: frame.mapping ?? null,
    provenance: frame.provenance ?? null,
    documentEpoch: frame.documentEpoch ?? null,
    runGeneration: frame.runGeneration ?? null,
    pinned: frame.pinned === true,
  };
}



/* ------------------------------------------------------------------ */
/* JPEG：baseline / extended sequential 纯 JS 解码                      */
/* ------------------------------------------------------------------ */

const JPEG_ZIGZAG = new Uint8Array([
  0, 1, 8, 16, 9, 2, 3, 10, 17, 24, 32, 25, 18, 11, 4, 5,
  12, 19, 26, 33, 40, 48, 41, 34, 27, 20, 13, 6, 7, 14, 21, 28,
  35, 42, 49, 56, 57, 50, 43, 36, 29, 22, 15, 23, 30, 37, 44, 51,
  58, 59, 52, 45, 38, 31, 39, 46, 53, 60, 61, 54, 47, 55, 62, 63,
]);

const IDCT_BASIS = (() => {
  const basis = new Float64Array(64);
  for (let u = 0; u < 8; u += 1) {
    for (let x = 0; x < 8; x += 1) {
      const scale = u === 0 ? Math.SQRT1_2 : 1;
      basis[u * 8 + x] = (scale * Math.cos(((2 * x + 1) * u * Math.PI) / 16)) / 2;
    }
  }
  return basis;
})();

function jpegError(code, message) {
  const error = new Error(message);
  error.decoderCode = code;
  return error;
}

function parseJpegDqt(segment, qtTables) {
  let index = 0;
  while (index < segment.length) {
    const pq = segment[index] >> 4;
    const tq = segment[index] & 15;
    index += 1;
    if (pq !== 0) throw jpegError('DECODER_UNSUPPORTED', '16-bit quantization table unsupported');
    if (tq > 3) throw jpegError('DECODER_INVALID', 'invalid quantization table id');
    if (index + 64 > segment.length) throw jpegError('DECODER_TRUNCATED', 'truncated DQT');
    const table = new Int32Array(64);
    for (let k = 0; k < 64; k += 1) table[JPEG_ZIGZAG[k]] = segment[index + k];
    index += 64;
    qtTables[tq] = table;
  }
}

function buildHuffmanTable(counts, symbols) {
  const minCode = new Int32Array(17).fill(-1);
  const maxCode = new Int32Array(17).fill(-1);
  const valuePointer = new Int32Array(17);
  let code = 0;
  let pointer = 0;
  for (let length = 1; length <= 16; length += 1) {
    const count = counts[length - 1];
    if (count > 0) {
      minCode[length] = code;
      valuePointer[length] = pointer;
      code += count;
      maxCode[length] = code - 1;
      pointer += count;
    }
    code <<= 1;
  }
  return { minCode, maxCode, valuePointer, symbols };
}

function parseJpegDht(segment, dcTables, acTables) {
  let index = 0;
  while (index < segment.length) {
    const tc = segment[index] >> 4;
    const th = segment[index] & 15;
    index += 1;
    if (tc > 1 || th > 3) throw jpegError('DECODER_INVALID', 'invalid huffman table selector');
    const counts = new Uint8Array(16);
    let total = 0;
    for (let k = 0; k < 16; k += 1) {
      counts[k] = segment[index + k];
      total += counts[k];
    }
    index += 16;
    if (total === 0 || total > 256 || index + total > segment.length) {
      throw jpegError('DECODER_INVALID', 'invalid huffman table');
    }
    const symbols = segment.subarray(index, index + total);
    index += total;
    const table = buildHuffmanTable(counts, symbols);
    (tc === 0 ? dcTables : acTables)[th] = table;
  }
}

function parseJpegSof(segment, marker, existing) {
  if (existing) throw jpegError('DECODER_INVALID', 'duplicate SOF');
  if (marker === 0xC2 || marker === 0xC3 || marker === 0xC6 || marker === 0xC7
    || marker === 0xCA || marker === 0xCB || marker === 0xCE || marker === 0xCF) {
    throw jpegError('DECODER_UNSUPPORTED', 'progressive/lossless JPEG unsupported');
  }
  if (segment.length < 6 + 1) throw jpegError('DECODER_TRUNCATED', 'truncated SOF');
  const precision = segment[0];
  if (precision !== 8) throw jpegError('DECODER_UNSUPPORTED', 'only 8-bit precision supported');
  const height = (segment[1] << 8) | segment[2];
  const width = (segment[3] << 8) | segment[4];
  const componentCount = segment[5];
  if (width === 0 || height === 0) throw jpegError('DECODER_INVALID', 'zero dimension');
  if (componentCount !== 1 && componentCount !== 3) {
    throw jpegError('DECODER_UNSUPPORTED', 'only grayscale and YCbCr/RGB JPEG supported');
  }
  if (segment.length < 6 + componentCount * 3) throw jpegError('DECODER_TRUNCATED', 'truncated SOF components');
  if (width * height > T4_LIMITS.maxFramePixels) {
    throw jpegError('DECODER_LIMIT', 'decoded pixels exceed T4 maxFramePixels');
  }
  const components = [];
  let maxH = 1;
  let maxV = 1;
  for (let index = 0; index < componentCount; index += 1) {
    const offset = 6 + index * 3;
    const id = segment[offset];
    const h = segment[offset + 1] >> 4;
    const v = segment[offset + 1] & 15;
    const tq = segment[offset + 2];
    if (h < 1 || h > 4 || v < 1 || v > 4) throw jpegError('DECODER_INVALID', 'invalid sampling factor');
    if (tq > 3) throw jpegError('DECODER_INVALID', 'invalid quantization table id');
    maxH = Math.max(maxH, h);
    maxV = Math.max(maxV, v);
    components.push({ id, h, v, tq, index, blocksX: 0, blocksY: 0, coeffs: null, plane: null });
  }
  const frame = { width, height, components, maxH, maxV, precision };
  for (const component of components) {
    const componentWidth = Math.ceil((width * component.h) / maxH);
    const componentHeight = Math.ceil((height * component.v) / maxV);
    component.blocksX = Math.ceil(componentWidth / 8);
    component.blocksY = Math.ceil(componentHeight / 8);
    component.coeffs = new Int32Array(component.blocksX * component.blocksY * 64);
  }
  return frame;
}

function parseJpegSos(segment, frame) {
  if (segment.length < 1) throw jpegError('DECODER_TRUNCATED', 'truncated SOS');
  const count = segment[0];
  if (count < 1 || count > 4) throw jpegError('DECODER_INVALID', 'invalid SOS component count');
  if (segment.length < 1 + count * 2 + 3) throw jpegError('DECODER_TRUNCATED', 'truncated SOS header');
  const entries = [];
  for (let index = 0; index < count; index += 1) {
    const id = segment[1 + index * 2];
    const selector = segment[2 + index * 2];
    const component = frame.components.find((candidate) => candidate.id === id);
    if (!component) throw jpegError('DECODER_INVALID', 'SOS references unknown component');
    entries.push({ component, dc: selector >> 4, ac: selector & 15 });
  }
  const tail = 1 + count * 2;
  const ss = segment[tail];
  const se = segment[tail + 1];
  const ahal = segment[tail + 2];
  if (ss !== 0 || se !== 63 || ahal !== 0) {
    throw jpegError('DECODER_UNSUPPORTED', 'progressive/arithmetic scan parameters unsupported');
  }
  return { entries };
}

function createJpegBitReader(data, start) {
  let pos = start;
  let bits = 0;
  let value = 0;
  const readByte = () => {
    if (pos >= data.length) throw jpegError('DECODER_TRUNCATED', 'entropy data truncated');
    const byte = data[pos];
    pos += 1;
    if (byte !== 0xFF) return byte;
    if (pos >= data.length) throw jpegError('DECODER_TRUNCATED', 'dangling 0xFF in entropy data');
    const next = data[pos];
    if (next === 0x00) {
      pos += 1;
      return 0xFF;
    }
    throw jpegError('DECODER_TRUNCATED', 'marker inside entropy data before MCU completion');
  };
  return {
    readBit() {
      if (bits === 0) {
        value = readByte();
        bits = 8;
      }
      bits -= 1;
      return (value >> bits) & 1;
    },
    readBits(count) {
      let output = 0;
      for (let index = 0; index < count; index += 1) output = (output << 1) | this.readBit();
      return output;
    },
    align() {
      bits = 0;
    },
    expectRestart() {
      bits = 0;
      if (pos + 1 < data.length && data[pos] === 0xFF && data[pos + 1] >= 0xD0 && data[pos + 1] <= 0xD7) {
        pos += 2;
        return;
      }
      throw jpegError('DECODER_TRUNCATED', 'missing restart marker');
    },
    finish() {
      bits = 0;
      while (pos + 1 < data.length) {
        if (data[pos] === 0xFF) {
          const next = data[pos + 1];
          if (next === 0x00) {
            pos += 2;
            continue;
          }
          if (next >= 0xD0 && next <= 0xD7) {
            pos += 2;
            continue;
          }
          return pos;
        }
        pos += 1;
      }
      return Math.min(pos, data.length);
    },
  };
}

function decodeJpegHuffman(reader, table) {
  if (!table) throw jpegError('DECODER_INVALID', 'missing huffman table');
  let code = 0;
  for (let length = 1; length <= 16; length += 1) {
    code = (code << 1) | reader.readBit();
    const maximum = table.maxCode[length];
    if (maximum >= 0 && code <= maximum) {
      return table.symbols[table.valuePointer[length] + code - table.minCode[length]];
    }
  }
  throw jpegError('DECODER_INVALID', 'invalid huffman code');
}

function decodeJpegBlock(reader, dcTable, acTable, coefficients, offset, predictors, componentIndex) {
  coefficients.fill(0, offset, offset + 64);
  const dcSize = decodeJpegHuffman(reader, dcTable);
  if (dcSize > 11) throw jpegError('DECODER_INVALID', 'invalid DC category');
  let dcDifference = 0;
  if (dcSize > 0) {
    dcDifference = reader.readBits(dcSize);
    if (dcDifference < (1 << (dcSize - 1))) dcDifference -= (1 << dcSize) - 1;
  }
  predictors[componentIndex] += dcDifference;
  coefficients[offset] = predictors[componentIndex];
  let zigzagIndex = 1;
  while (zigzagIndex < 64) {
    const symbol = decodeJpegHuffman(reader, acTable);
    const run = symbol >> 4;
    const size = symbol & 15;
    if (size === 0) {
      if (run === 15) {
        zigzagIndex += 16;
        continue;
      }
      break;
    }
    zigzagIndex += run;
    if (zigzagIndex > 63) throw jpegError('DECODER_INVALID', 'AC run exceeds block');
    let value = reader.readBits(size);
    if (value < (1 << (size - 1))) value -= (1 << size) - 1;
    coefficients[offset + JPEG_ZIGZAG[zigzagIndex]] = value;
    zigzagIndex += 1;
  }
}

function decodeJpegScan(data, start, frame, scan, qtTables, dcTables, acTables, restartInterval) {
  const reader = createJpegBitReader(data, start);
  const interleaved = scan.entries.length > 1;
  const { maxH, maxV, width, height } = frame;
  const first = scan.entries[0].component;
  const mcusX = interleaved ? Math.ceil(width / (8 * maxH)) : Math.ceil(Math.ceil((width * first.h) / maxH) / 8);
  const mcusY = interleaved ? Math.ceil(height / (8 * maxV)) : Math.ceil(Math.ceil((height * first.v) / maxV) / 8);
  const predictors = new Int32Array(frame.components.length);
  const scratch = new Int32Array(64);
  let sinceRestart = 0;
  for (let mcuY = 0; mcuY < mcusY; mcuY += 1) {
    for (let mcuX = 0; mcuX < mcusX; mcuX += 1) {
      if (restartInterval > 0 && sinceRestart === restartInterval) {
        reader.align();
        reader.expectRestart();
        predictors.fill(0);
        sinceRestart = 0;
      }
      for (const entry of scan.entries) {
        const component = entry.component;
        const dcTable = dcTables[entry.dc];
        const acTable = acTables[entry.ac];
        const horizontal = interleaved ? component.h : 1;
        const vertical = interleaved ? component.v : 1;
        for (let blockY = 0; blockY < vertical; blockY += 1) {
          for (let blockX = 0; blockX < horizontal; blockX += 1) {
            const targetX = interleaved ? mcuX * component.h + blockX : mcuX;
            const targetY = interleaved ? mcuY * component.v + blockY : mcuY;
            if (targetX >= component.blocksX || targetY >= component.blocksY) {
              decodeJpegBlock(reader, dcTable, acTable, scratch, 0, predictors, component.index);
              continue;
            }
            const offset = (targetY * component.blocksX + targetX) * 64;
            decodeJpegBlock(reader, dcTable, acTable, component.coeffs, offset, predictors, component.index);
          }
        }
      }
      sinceRestart += 1;
    }
  }
  return reader.finish();
}

function idctJpegBlock(coefficients, offset, quantTable, plane, planeWidth, planeHeight, originX, originY, scratch) {
  for (let v = 0; v < 8; v += 1) {
    for (let x = 0; x < 8; x += 1) {
      let sum = 0;
      for (let u = 0; u < 8; u += 1) {
        sum += coefficients[offset + v * 8 + u] * quantTable[v * 8 + u] * IDCT_BASIS[u * 8 + x];
      }
      scratch[v * 8 + x] = sum;
    }
  }
  for (let y = 0; y < 8; y += 1) {
    for (let x = 0; x < 8; x += 1) {
      let sum = 0;
      for (let v = 0; v < 8; v += 1) sum += scratch[v * 8 + x] * IDCT_BASIS[v * 8 + y];
      const target = Math.max(0, Math.min(255, Math.round(sum + 128)));
      const px = originX + x;
      const py = originY + y;
      if (px < planeWidth && py < planeHeight) plane[py * planeWidth + px] = target;
    }
  }
}

function jpegComponentSample(component, x, y, maxH, maxV) {
  const sampleX = Math.floor((x * component.h) / maxH);
  const sampleY = Math.floor((y * component.v) / maxV);
  const planeWidth = component.blocksX * 8;
  const planeHeight = component.blocksY * 8;
  const clampedX = Math.min(sampleX, planeWidth - 1);
  const clampedY = Math.min(sampleY, planeHeight - 1);
  return component.plane[clampedY * planeWidth + clampedX];
}

function renderJpegFrame(frame, qtTables, adobeTransform) {
  for (const component of frame.components) {
    const planeWidth = component.blocksX * 8;
    const planeHeight = component.blocksY * 8;
    const quantTable = qtTables[component.tq];
    if (!quantTable) throw jpegError('DECODER_INVALID', 'missing quantization table');
    component.plane = new Uint8Array(planeWidth * planeHeight);
    const scratch = new Float64Array(64);
    for (let blockY = 0; blockY < component.blocksY; blockY += 1) {
      for (let blockX = 0; blockX < component.blocksX; blockX += 1) {
        const offset = (blockY * component.blocksX + blockX) * 64;
        idctJpegBlock(
          component.coeffs, offset, quantTable, component.plane,
          planeWidth, planeHeight, blockX * 8, blockY * 8, scratch,
        );
      }
    }
  }
  const { width, height, components, maxH, maxV } = frame;
  const rgba = new Uint8ClampedArray(width * height * 4);
  const directRgb = components.length === 3 && adobeTransform === 0;
  for (let y = 0; y < height; y += 1) {
    for (let x = 0; x < width; x += 1) {
      const output = (y * width + x) * 4;
      if (components.length === 1) {
        const luminance = jpegComponentSample(components[0], x, y, maxH, maxV);
        rgba[output] = luminance;
        rgba[output + 1] = luminance;
        rgba[output + 2] = luminance;
        rgba[output + 3] = 255;
        continue;
      }
      const first = jpegComponentSample(components[0], x, y, maxH, maxV);
      const second = jpegComponentSample(components[1], x, y, maxH, maxV);
      const third = jpegComponentSample(components[2], x, y, maxH, maxV);
      if (directRgb) {
        rgba[output] = first;
        rgba[output + 1] = second;
        rgba[output + 2] = third;
        rgba[output + 3] = 255;
        continue;
      }
      const cb = second - 128;
      const cr = third - 128;
      rgba[output] = first + 1.402 * cr;
      rgba[output + 1] = first - 0.344136 * cb - 0.714136 * cr;
      rgba[output + 2] = first + 1.772 * cb;
      rgba[output + 3] = 255;
    }
  }
  return { width, height, rgba };
}

function decodeJpegInternal(data) {
  if (data.length < 4 || data[0] !== 0xFF || data[1] !== 0xD8) {
    throw jpegError('DECODER_INVALID', 'missing SOI');
  }
  const qtTables = new Array(4).fill(null);
  const dcTables = new Array(4).fill(null);
  const acTables = new Array(4).fill(null);
  let frame = null;
  let restartInterval = 0;
  let adobeTransform = null;
  let scanCount = 0;
  let pos = 2;
  while (pos + 1 < data.length) {
    if (data[pos] !== 0xFF) {
      pos += 1;
      continue;
    }
    const marker = data[pos + 1];
    if (marker === 0xFF) {
      pos += 1;
      continue;
    }
    pos += 2;
    if (marker === 0xD9) break;
    if (marker >= 0xD0 && marker <= 0xD7) continue;
    if (marker === 0x01) continue;
    if (pos + 2 > data.length) throw jpegError('DECODER_TRUNCATED', 'truncated before segment length');
    const segmentLength = (data[pos] << 8) | data[pos + 1];
    if (segmentLength < 2 || pos + segmentLength > data.length) {
      throw jpegError('DECODER_TRUNCATED', 'segment exceeds file length');
    }
    const segment = data.subarray(pos + 2, pos + segmentLength);
    let nextPos = pos + segmentLength;
    switch (marker) {
      case 0xDB: parseJpegDqt(segment, qtTables); break;
      case 0xC4: parseJpegDht(segment, dcTables, acTables); break;
      case 0xC0:
      case 0xC1:
        frame = parseJpegSof(segment, marker, frame);
        break;
      case 0xC2: case 0xC3: case 0xC5: case 0xC6:
      case 0xC7: case 0xC9: case 0xCA: case 0xCB:
      case 0xCD: case 0xCE: case 0xCF:
        throw jpegError('DECODER_UNSUPPORTED', 'progressive/lossless/arithmetic JPEG unsupported');
      case 0xDD:
        if (segment.length < 2) throw jpegError('DECODER_TRUNCATED', 'truncated DRI');
        restartInterval = (segment[0] << 8) | segment[1];
        break;
      case 0xEE:
        if (segment.length >= 12
          && segment[0] === 0x41 && segment[1] === 0x64 && segment[2] === 0x6F
          && segment[3] === 0x62 && segment[4] === 0x65) {
          adobeTransform = segment[11];
        }
        break;
      case 0xDA: {
        if (!frame) throw jpegError('DECODER_INVALID', 'SOS before SOF');
        const scan = parseJpegSos(segment, frame);
        nextPos = decodeJpegScan(
          data, nextPos, frame, scan, qtTables, dcTables, acTables, restartInterval,
        );
        scanCount += 1;
        break;
      }
      default:
        break;
    }
    pos = nextPos;
  }
  if (!frame) throw jpegError('DECODER_INVALID', 'missing SOF');
  if (scanCount === 0) throw jpegError('DECODER_INVALID', 'missing SOS');
  const rendered = renderJpegFrame(frame, qtTables, adobeTransform);
  return rendered;
}

/**
 * baseline / extended sequential JPEG → RGBA8。纯 JS、零依赖、零 CDP。
 * SOF0/SOF1、4:2:0/4:2:2/4:4:4、标准或自定义 Huffman 表、DRI/RST 均支持；
 * progressive（SOF2）、arithmetic、16-bit、CMYK 等返回 `{ok:false,code:'DECODER_UNSUPPORTED'}`
 * 而不是抛错或猜像素。返回的 rgba 是 **Uint8ClampedArray**，编码字节与像素 hash 由调用方分列。
 */
export function decodeJpegRgba(bytes) {
  if (!(bytes instanceof Uint8Array) && !Buffer.isBuffer(bytes)) {
    return { ok: false, code: 'DECODER_INVALID', message: 'jpeg bytes must be a byte array' };
  }
  const data = bytes instanceof Uint8Array ? bytes : Buffer.from(bytes);
  try {
    const rendered = decodeJpegInternal(data);
    return {
      ok: true,
      width: rendered.width,
      height: rendered.height,
      rgba: rendered.rgba,
      decoder: JPEG_DECODER_ID,
      decoderProvenance: { kind: 'host-node-pure-js', version: 1 },
    };
  } catch (error) {
    const code = error && error.decoderCode ? error.decoderCode : 'DECODER_INVALID';
    return {
      ok: false,
      code,
      message: typeof error?.message === 'string' ? error.message.slice(0, 200) : 'jpeg decode failed',
    };
  }
}

/** PNG/JPEG 分派解码（PNG 复用 vision-t3 的 decodePngToRgba）。格式错误返回 ok:false，不抛。 */
export function decodeFrameRgba(frameOrBytes) {
  const isFrame = isPlainObject(frameOrBytes);
  const encoding = isFrame ? frameOrBytes.encoding ?? null : null;
  const bytes = isFrame ? (frameOrBytes.bytes ?? frameOrBytes.encodedBytes) : frameOrBytes;
  if (!(bytes instanceof Uint8Array) && !Buffer.isBuffer(bytes)) {
    return { ok: false, code: 'DECODER_INVALID', message: 'frame bytes required' };
  }
  const data = bytes instanceof Uint8Array ? bytes : Buffer.from(bytes);
  const isJpeg = encoding === 'jpeg' || encoding === null
    ? data[0] === 0xFF && data[1] === 0xD8
    : false;
  const isPng = encoding === 'png' || (encoding === null && data[0] === 0x89 && data[1] === 0x50);
  if (encoding === 'jpeg' || (encoding === null && isJpeg)) {
    return decodeJpegRgba(data);
  }
  if (encoding === 'png' || (encoding === null && isPng)) {
    const decoded = decodePngToRgba(data);
    if (!decoded.ok) {
      return { ok: false, code: decoded.code ?? 'DECODER_INVALID', message: decoded.message ?? 'png decode failed' };
    }
    return {
      ok: true,
      width: decoded.width,
      height: decoded.height,
      rgba: decoded.rgba,
      decoder: 't3-png',
      decoderProvenance: { kind: 'host-node-pure-js', version: 1 },
    };
  }
  return { ok: false, code: 'DECODER_UNSUPPORTED', message: `unsupported encoding: ${String(encoding)}` };
}

/**
 * 把帧记录（store 记录或 `{encoding,bytes}`）物化为可分析 image；不写回 store、不抛。
 * 返回 `{ok:true,image:{width,height,rgba},decoder,decoderProvenance}` 或 `{ok:false,code,message}`。
 * Host 侧解码失败时把 `decode.failed=true` 记录到帧证据，依赖像素的断言自然 INCONCLUSIVE。
 */
export function materializeFrameImage(frame) {
  if (!isPlainObject(frame)) {
    return { ok: false, code: 'DECODER_INVALID', message: 'frame object required' };
  }
  if (frame.image) {
    return {
      ok: true,
      image: frame.image,
      decoder: frame.decode?.decoder ?? null,
      decoderProvenance: frame.decode?.decoderProvenance ?? null,
    };
  }
  const decoded = decodeFrameRgba({ encoding: frame.encoding ?? null, bytes: frame.bytes ?? frame.encodedBytes });
  if (!decoded.ok) return decoded;
  return {
    ok: true,
    image: { width: decoded.width, height: decoded.height, rgba: decoded.rgba },
    decoder: decoded.decoder,
    decoderProvenance: decoded.decoderProvenance,
  };
}


/**
 * 帧 ROI 裁剪（crop-on-delivery 纯核心）：让 Agent 只拿动画区域，不读整页截图。
 *
 * 动机（实测，Lead 2026-11-04）：同一帧整页 JPEG 61,824 B，而裁出 243×139 的 PNG 只有
 * 4,198 B（约 14.7×）；整页截图还会把页面自述文字（例如 `t=233ms tx=93.32`）一起喂给
 * Agent，等于让 Agent 读答案而不是看运动。因此只交付裁剪后的 RGBA 与 ROI 像素 hash。
 *
 * 约定：
 *  - region 必须是完全落在帧图像像素内的整数 PixelRect（x/y>=0、width/height>=1），越界/负值/
 *    零面积一律 crop-failed，**不 clamp、不自动对齐**。
 *  - `roiSha256` 对**裁剪后 RGBA** 计算，绝不复用整帧 encodedSha256；`source.sha256` 才是整帧
 *    编码 hash（缺失时对 bytes 现算，纯图像帧为 null）。
 *  - 帧只有 bytes+encoding 时用 `materializeFrameImage` 解码（JPEG/PNG 均可）；
 *    解码失败返回 `decoder-unavailable`，不抛错、不做 IO、不落盘。
 */
export function cropFrameRoi(frame, region) {
  const cropFailure = (code, message) => ({ ok: false, code, message });
  if (!isPlainObject(region)) return cropFailure('crop-failed', 'region must be a PixelRect object');
  const { x, y, width, height } = region;
  const fields = [x, y, width, height];
  if (!fields.every((value) => typeof value === 'number' && Number.isFinite(value) && Number.isInteger(value))) {
    return cropFailure('crop-failed', 'region must contain integer x/y/width/height');
  }
  if (x < 0 || y < 0 || width < 1 || height < 1) {
    return cropFailure('crop-failed', 'region must be non-negative with positive width/height');
  }
  if (!isPlainObject(frame)) return cropFailure('decoder-unavailable', 'frame must be an object');

  let image = frame.image ?? null;
  if (image === null) {
    const materialized = materializeFrameImage(frame);
    if (!materialized.ok) {
      return cropFailure('decoder-unavailable', materialized.message ?? materialized.code ?? 'frame decode failed');
    }
    image = materialized.image;
  }
  if (!isPlainObject(image)
    || !Number.isInteger(image.width) || image.width < 1
    || !Number.isInteger(image.height) || image.height < 1
    || !(image.rgba instanceof Uint8Array) && !(image.rgba instanceof Uint8ClampedArray)
    || image.rgba.length !== image.width * image.height * 4) {
    return cropFailure('decoder-unavailable', 'frame image is not a valid RGBA image');
  }
  if (x + width > image.width || y + height > image.height) {
    return cropFailure('crop-failed', 'region exceeds frame image bounds');
  }

  const analysisImage = image.rgba instanceof Uint8Array
    ? image
    : { width: image.width, height: image.height, rgba: new Uint8Array(image.rgba.buffer, image.rgba.byteOffset, image.rgba.byteLength) };
  let cropped;
  try {
    cropped = cropImage(analysisImage, { x, y, width, height });
  } catch {
    // cropImage 只在非法 rect/超输出预算时抛；这里已做纯预检，仍统一降级为 crop-failed。
    return cropFailure('crop-failed', 'crop failed');
  }
  if (cropped.width !== width || cropped.height !== height || cropped.rgba.length !== width * height * 4) {
    return cropFailure('crop-failed', 'crop output size mismatch');
  }
  const rgba = cropped.rgba instanceof Uint8Array
    ? cropped.rgba
    : new Uint8Array(cropped.rgba.buffer, cropped.rgba.byteOffset, cropped.rgba.byteLength);
  const roiSha256 = sha256Hex(Buffer.from(rgba.buffer, rgba.byteOffset, rgba.byteLength));
  const encodedSha256 = frame.encodedSha256 ?? frame.sha256 ?? null;
  const sourceSha256 = encodedSha256
    ?? (frame.bytes instanceof Uint8Array || Buffer.isBuffer(frame.bytes) ? sha256Hex(frame.bytes) : null);
  return {
    ok: true,
    image: { width: cropped.width, height: cropped.height, rgba },
    roiSha256,
    source: {
      sha256: sourceSha256,
      width: image.width,
      height: image.height,
      encoding: frame.encoding ?? null,
    },
    region: { x, y, width, height },
  };
}

