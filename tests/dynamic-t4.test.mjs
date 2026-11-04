/**
 * dynamic-t4.test.mjs — WEB-T4 纯核心的 U 类单测（零浏览器、零 CDP、零文件系统写入）。
 *
 * 契约来源：docs/t4-dynamic-behavior.md
 * §6/§7/§9。断言口径：
 *  - 失败优先：FAIL > BLOCKED > INCONCLUSIVE > WARN > PASS；runMotionAssertions 的 exitCode
 *    1/2/0 与 T3 一致，不调用 process.exit。
 *  - 断言极性按契约 §2.4：frame-diff/region-change 达到 changeRatio 为 FAIL；flicker/freeze/jank
 *    检出异常为 FAIL；trajectory 唯一连续跟踪为 PASS；transition 完整边界为 PASS。
 *  - 缺证据是 INCONCLUSIVE/BLOCKED，不因“没看见”直接 PASS；未知/跨会话 ID 同形 NOT_FOUND。
 *
 * 运行：`node --test tests/dynamic-t4.test.mjs`
 * 纯逻辑：合成 RGBA 帧 + 注入时钟；不读 fixture anomalies，不启动浏览器。
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';

import {
  DC_ALGORITHM_VERSION, DC_BASIS, DC_CONFIDENCE, DC_DIRECTIONS, DC_GRADE_MAP,
  DynamicEventLog, DynamicFrameStore, MOTION_TYPES, T4_ALGORITHM_VERSION, T4_LIMITS, T4_VERSION,
  cropFrameRoi, decodeFrameRgba, decodeJpegRgba, frameMeta, materializeFrameImage, runMotionAssertionsAsync,
  validateSessionDuration, validateSessionExtend,
  analyzeFlicker, analyzeFrameDiff, analyzeFreeze, analyzeJank, analyzeRegionChange,
  analyzeTrajectory, analyzeTransition, buildEventTime, compareTimelineEvents, correlateDynamic,
  createClockAnchor, decodeCorrelationCursor, encodeCorrelationCursor, intervalsOverlap,
  isClockUncertain, mergeClockAnchors, normalizeDynamicEvent, resolveOrder, runMotionAssertions,
  sortTimeline, validateCorrelationInput, validateMotionAssertions,
} from '../dynamic-t4.js';

/* ------------------------------------------------------------------ */
/* helpers                                                             */
/* ------------------------------------------------------------------ */

const WHITE = [255, 255, 255, 255];
const BLACK = [0, 0, 0, 255];
const RED = [255, 0, 0, 255];
const BLUE = [0, 0, 255, 255];
const GREEN = [0, 128, 0, 255];

function fillImage(width, height, color, patches = []) {
  const rgba = new Uint8Array(width * height * 4);
  for (let index = 0; index < width * height; index += 1) {
    rgba[index * 4] = color[0];
    rgba[index * 4 + 1] = color[1];
    rgba[index * 4 + 2] = color[2];
    rgba[index * 4 + 3] = color[3];
  }
  for (const patch of patches) {
    const endY = Math.min(height, patch.y + patch.height);
    const endX = Math.min(width, patch.x + patch.width);
    for (let y = patch.y; y < endY; y += 1) {
      for (let x = patch.x; x < endX; x += 1) {
        const offset = (y * width + x) * 4;
        rgba[offset] = patch.color[0];
        rgba[offset + 1] = patch.color[1];
        rgba[offset + 2] = patch.color[2];
        rgba[offset + 3] = patch.color[3];
      }
    }
  }
  return { width, height, rgba };
}

function frame({
  id = 'f1', seq = null, timelineMs = null, receivedMonoMs = null, sourceTimestamp = null,
  image = null, encoding = null, mapping = null, clockUncertain = false,
} = {}) {
  return {
    frameId: id, seq, timelineMs, receivedMonoMs, sourceTimestamp, image, encoding, mapping, clockUncertain,
  };
}

function solidFrames(width, height, colors, { startMs = 0, stepMs = 40, seqStart = 1, encoding = null } = {}) {
  return colors.map((color, index) => frame({
    id: `f${seqStart + index}`,
    seq: seqStart + index,
    timelineMs: startMs + index * stepMs,
    receivedMonoMs: 1000 + startMs + index * stepMs,
    image: fillImage(width, height, color),
    encoding,
  }));
}

function solid(...colors) {
  return solidFrames(20, 20, colors);
}

function event(overrides = {}) {
  const base = {
    domain: 'operation',
    kind: 'click',
    phase: 'completed',
    scopeId: 'scope-1',
    dynamicSessionId: 'ds-1',
    ts: { timelineMs: 100, receivedMonoMs: 1000 },
    provenance: { producer: 'host', sourceKind: 'tool-action', trust: 'host-observed' },
    ids: {},
    payload: {},
  };
  return {
    ...base,
    ...overrides,
    ts: { ...base.ts, ...(overrides.ts ?? {}) },
    provenance: { ...base.provenance, ...(overrides.provenance ?? {}) },
    ids: { ...base.ids, ...(overrides.ids ?? {}) },
    payload: { ...base.payload, ...(overrides.payload ?? {}) },
  };
}

function visualEvent(overrides = {}) {
  return event({
    domain: 'visual',
    kind: 'frame',
    provenance: { producer: 'host', sourceKind: 'screencast', trust: 'host-observed' },
    ...overrides,
  });
}

function networkEvent(overrides = {}) {
  return event({
    domain: 'network',
    kind: 'http',
    phase: 'response',
    provenance: { producer: 'host', sourceKind: 'cdp-network', trust: 'cdp-observed' },
    ...overrides,
  });
}

function requestKey(requestId, { networkSessionId = 'ns-1', targetId = 'T1', cdpSessionId = 'C1', hopId = 0 } = {}) {
  return { networkSessionId, targetId, cdpSessionId, requestId, hopId };
}

function requestKeyString(key) {
  return [key.networkSessionId ?? '', key.targetId ?? '', key.cdpSessionId ?? '', key.requestId,
    Number.isInteger(key.hopId) ? key.hopId : 0].join('\u0000');
}

function catchError(fn) {
  try {
    fn();
  } catch (error) {
    return error;
  }
  assert.fail('expected an error');
}

function integrityComplete() {
  return {
    complete: true, captured: 3, retained: 3, dropped: 0, evicted: 0, truncated: false,
    ackFailures: 0, gaps: [], issues: [],
    coverage: {
      source: {}, segments: [], maxAdjacentIntervalMs: 40, missingSourceTimestamps: 0,
      samplingFailures: 0, decodeFailures: 0, adapters: [], unknownSourceDrops: null,
    },
  };
}

function frozenExpectation() {
  return {
    motionExpected: true,
    sourceEventId: 'ev-expect',
    referenceEventIds: ['ev-ref'],
  };
}

function advancingEvents() {
  return [
    event({ eventId: 'ev-expect', domain: 'operation', kind: 'click', payload: { targetId: 'anim' } }),
    event({
      eventId: 'ev-ref',
      domain: 'marker',
      kind: 'clock-advance',
      provenance: { producer: 'host', sourceKind: 'adapter-readback', trust: 'host-observed' },
      payload: { clockId: 'page' },
    }),
  ];
}

/* ------------------------------------------------------------------ */
/* JPEG fixtures（PIL 生成的真实 baseline JPEG；Chromium canvas fixture 待 executor-B 替换）*/
/* ------------------------------------------------------------------ */

const FIXTURE_JPEG444 = {
  sha256: 'e66be4b5d37a0f35b6a1a46aa46bf296d1a88cb6b9cce69767c8170dd2686986',
  bytes: 910,
  base64: [
    '/9j/4AAQSkZJRgABAQAAAQABAAD/2wBDAAIBAQEBAQIBAQECAgICAgQDAgICAgUEBAMEBgUGBgYFBgYGBwkIBgcJBwYGCAsICQoK',
    'CgoKBggLDAsKDAkKCgr/2wBDAQICAgICAgUDAwUKBwYHCgoKCgoKCgoKCgoKCgoKCgoKCgoKCgoKCgoKCgoKCgoKCgoKCgoKCgoK',
    'CgoKCgoKCgr/wAARCAAYACADAREAAhEBAxEB/8QAHwAAAQUBAQEBAQEAAAAAAAAAAAECAwQFBgcICQoL/8QAtRAAAgEDAwIEAwUF',
    'BAQAAAF9AQIDAAQRBRIhMUEGE1FhByJxFDKBkaEII0KxwRVS0fAkM2JyggkKFhcYGRolJicoKSo0NTY3ODk6Q0RFRkdISUpTVFVW',
    'V1hZWmNkZWZnaGlqc3R1dnd4eXqDhIWGh4iJipKTlJWWl5iZmqKjpKWmp6ipqrKztLW2t7i5usLDxMXGx8jJytLT1NXW19jZ2uHi',
    '4+Tl5ufo6erx8vP09fb3+Pn6/8QAHwEAAwEBAQEBAQEBAQAAAAAAAAECAwQFBgcICQoL/8QAtREAAgECBAQDBAcFBAQAAQJ3AAEC',
    'AxEEBSExBhJBUQdhcRMiMoEIFEKRobHBCSMzUvAVYnLRChYkNOEl8RcYGRomJygpKjU2Nzg5OkNERUZHSElKU1RVVldYWVpjZGVm',
    'Z2hpanN0dXZ3eHl6goOEhYaHiImKkpOUlZaXmJmaoqOkpaanqKmqsrO0tba3uLm6wsPExcbHyMnK0tPU1dbX2Nna4uPk5ebn6Onq',
    '8vP09fb3+Pn6/9oADAMBAAIRAxEAPwD5fr8TP9eD1r4Zf8iPY/8AbX/0a9ebiP4zP8E/ppf8pMZ9/wByv/qFhzkP2q/+SeWf/Yaj',
    '/wDRM1f059Er/k4+L/7BKn/p6gfjvhr/AMj2p/17f/pUDwCv9Dj9uPVK/wAZz/eA9a+GX/Ij2P8A21/9GvXm4j+Mz/BP6aX/ACkx',
    'n3/cr/6hYc5D9qv/AJJ5Z/8AYaj/APRM1f059Er/AJOPi/8AsEqf+nqB+O+Gv/I9qf8AXt/+lQPAK/0OP249Ur/Gc/3gPWvhl/yI',
    '9j/21/8ARr15uI/jM/wT+ml/ykxn3/cr/wCoWHOQ/ar/AOSeWf8A2Go//RM1f059Er/k4+L/AOwSp/6eoH474a/8j2p/17f/AKVA',
    '8Ar/AEOP24//2Q==',
  ].join(''),
};

const FIXTURE_JPEG422 = {
  sha256: '46da539c476a43dc6fa6c42da42ca1d6673d0580458495bd773723531f374261',
  bytes: 836,
  base64: [
    '/9j/4AAQSkZJRgABAQAAAQABAAD/2wBDAAMCAgMCAgMDAwMEAwMEBQgFBQQEBQoHBwYIDAoMDAsKCwsNDhIQDQ4RDgsLEBYQERMU',
    'FRUVDA8XGBYUGBIUFRT/2wBDAQMEBAUEBQkFBQkUDQsNFBQUFBQUFBQUFBQUFBQUFBQUFBQUFBQUFBQUFBQUFBQUFBQUFBQUFBQU',
    'FBQUFBQUFBT/wAARCAAYACADASEAAhEBAxEB/8QAHwAAAQUBAQEBAQEAAAAAAAAAAAECAwQFBgcICQoL/8QAtRAAAgEDAwIEAwUF',
    'BAQAAAF9AQIDAAQRBRIhMUEGE1FhByJxFDKBkaEII0KxwRVS0fAkM2JyggkKFhcYGRolJicoKSo0NTY3ODk6Q0RFRkdISUpTVFVW',
    'V1hZWmNkZWZnaGlqc3R1dnd4eXqDhIWGh4iJipKTlJWWl5iZmqKjpKWmp6ipqrKztLW2t7i5usLDxMXGx8jJytLT1NXW19jZ2uHi',
    '4+Tl5ufo6erx8vP09fb3+Pn6/8QAHwEAAwEBAQEBAQEBAQAAAAAAAAECAwQFBgcICQoL/8QAtREAAgECBAQDBAcFBAQAAQJ3AAEC',
    'AxEEBSExBhJBUQdhcRMiMoEIFEKRobHBCSMzUvAVYnLRChYkNOEl8RcYGRomJygpKjU2Nzg5OkNERUZHSElKU1RVVldYWVpjZGVm',
    'Z2hpanN0dXZ3eHl6goOEhYaHiImKkpOUlZaXmJmaoqOkpaanqKmqsrO0tba3uLm6wsPExcbHyMnK0tPU1dbX2Nna4uPk5ebn6Onq',
    '8vP09fb3+Pn6/9oADAMBAAIRAxEAPwDxSu88Mf8AIDtv+Bf+hGvzGr8J+r/SJ/5JTDf9hEP/AE3VMD4q/wDIvW//AF9L/wCgPXlV',
    'f154X/8AJOx/xz/M/j7h7/cV6s7iu88Mf8gO2/4F/wChGv5Dq/Cf2D9In/klMN/2EQ/9N1TA+Kv/ACL1v/19L/6A9eVV/Xnhf/yT',
    'sf8AHP8AM/j7h7/cV6s7iu88Mf8AIDtv+Bf+hGv5Dq/Cf2D9In/klMN/2EQ/9N1TA+Kv/IvW/wD19L/6A9eVV/Xnhf8A8k7H/HP8',
    'z+PuHv8AcV6s/9k=',
  ].join(''),
};

const FIXTURE_JPEG420 = {
  sha256: 'b4a6af1812d5072b192008b535ad7ea7446c1e8d2518057b11e3fb58d78fa859',
  bytes: 802,
  base64: [
    '/9j/4AAQSkZJRgABAQAAAQABAAD/2wBDAAMCAgMCAgMDAwMEAwMEBQgFBQQEBQoHBwYIDAoMDAsKCwsNDhIQDQ4RDgsLEBYQERMU',
    'FRUVDA8XGBYUGBIUFRT/2wBDAQMEBAUEBQkFBQkUDQsNFBQUFBQUFBQUFBQUFBQUFBQUFBQUFBQUFBQUFBQUFBQUFBQUFBQUFBQU',
    'FBQUFBQUFBT/wAARCAAYACADASIAAhEBAxEB/8QAHwAAAQUBAQEBAQEAAAAAAAAAAAECAwQFBgcICQoL/8QAtRAAAgEDAwIEAwUF',
    'BAQAAAF9AQIDAAQRBRIhMUEGE1FhByJxFDKBkaEII0KxwRVS0fAkM2JyggkKFhcYGRolJicoKSo0NTY3ODk6Q0RFRkdISUpTVFVW',
    'V1hZWmNkZWZnaGlqc3R1dnd4eXqDhIWGh4iJipKTlJWWl5iZmqKjpKWmp6ipqrKztLW2t7i5usLDxMXGx8jJytLT1NXW19jZ2uHi',
    '4+Tl5ufo6erx8vP09fb3+Pn6/8QAHwEAAwEBAQEBAQEBAQAAAAAAAAECAwQFBgcICQoL/8QAtREAAgECBAQDBAcFBAQAAQJ3AAEC',
    'AxEEBSExBhJBUQdhcRMiMoEIFEKRobHBCSMzUvAVYnLRChYkNOEl8RcYGRomJygpKjU2Nzg5OkNERUZHSElKU1RVVldYWVpjZGVm',
    'Z2hpanN0dXZ3eHl6goOEhYaHiImKkpOUlZaXmJmaoqOkpaanqKmqsrO0tba3uLm6wsPExcbHyMnK0tPU1dbX2Nna4uPk5ebn6Onq',
    '8vP09fb3+Pn6/9oADAMBAAIRAxEAPwDxSu88Mf8AIDtv+Bf+hGuDrvPDH/IDtv8AgX/oRr8xq/Cfq/0if+SUw3/YRD/03VMD4q/8',
    'i9b/APX0v/oD15VXqvxV/wCRet/+vpf/AEB68qr+vPC//knY/wCOf5n8fcPf7ivVncV3nhj/AJAdt/wL/wBCNFFfyHV+E/sH6RP/',
    'ACSmG/7CIf8ApuqYHxV/5F63/wCvpf8A0B68qoor+vPC/wD5J2P+Of5n8fcPf7ivVn//2Q==',
  ].join(''),
};

const FIXTURE_JPEGBLACK = {
  sha256: 'f0a627fe3365462ead252bdb535f6d0d67f4be2cc3228ab7b037abe2d478b780',
  bytes: 643,
  base64: [
    '/9j/4AAQSkZJRgABAQAAAQABAAD/2wBDAAMCAgMCAgMDAwMEAwMEBQgFBQQEBQoHBwYIDAoMDAsKCwsNDhIQDQ4RDgsLEBYQERMU',
    'FRUVDA8XGBYUGBIUFRT/2wBDAQMEBAUEBQkFBQkUDQsNFBQUFBQUFBQUFBQUFBQUFBQUFBQUFBQUFBQUFBQUFBQUFBQUFBQUFBQU',
    'FBQUFBQUFBT/wAARCAAYACADASIAAhEBAxEB/8QAHwAAAQUBAQEBAQEAAAAAAAAAAAECAwQFBgcICQoL/8QAtRAAAgEDAwIEAwUF',
    'BAQAAAF9AQIDAAQRBRIhMUEGE1FhByJxFDKBkaEII0KxwRVS0fAkM2JyggkKFhcYGRolJicoKSo0NTY3ODk6Q0RFRkdISUpTVFVW',
    'V1hZWmNkZWZnaGlqc3R1dnd4eXqDhIWGh4iJipKTlJWWl5iZmqKjpKWmp6ipqrKztLW2t7i5usLDxMXGx8jJytLT1NXW19jZ2uHi',
    '4+Tl5ufo6erx8vP09fb3+Pn6/8QAHwEAAwEBAQEBAQEBAQAAAAAAAAECAwQFBgcICQoL/8QAtREAAgECBAQDBAcFBAQAAQJ3AAEC',
    'AxEEBSExBhJBUQdhcRMiMoEIFEKRobHBCSMzUvAVYnLRChYkNOEl8RcYGRomJygpKjU2Nzg5OkNERUZHSElKU1RVVldYWVpjZGVm',
    'Z2hpanN0dXZ3eHl6goOEhYaHiImKkpOUlZaXmJmaoqOkpaanqKmqsrO0tba3uLm6wsPExcbHyMnK0tPU1dbX2Nna4uPk5ebn6Onq',
    '8vP09fb3+Pn6/9oADAMBAAIRAxEAPwD8qqKKKACiiigAooooAKKKKAP/2Q==',
  ].join(''),
};

const FIXTURE_JPEGPROG = {
  sha256: 'a29872b235af4452f3732e984ae992583d5f0bbd773def3e3ff43ee09e6b762e',
  bytes: 653,
  base64: [
    '/9j/4AAQSkZJRgABAQAAAQABAAD/2wBDAAMCAgMCAgMDAwMEAwMEBQgFBQQEBQoHBwYIDAoMDAsKCwsNDhIQDQ4RDgsLEBYQERMU',
    'FRUVDA8XGBYUGBIUFRT/2wBDAQMEBAUEBQkFBQkUDQsNFBQUFBQUFBQUFBQUFBQUFBQUFBQUFBQUFBQUFBQUFBQUFBQUFBQUFBQU',
    'FBQUFBQUFBT/wgARCAAYACADASIAAhEBAxEB/8QAFwAAAwEAAAAAAAAAAAAAAAAAAAUGBP/EABUBAQEAAAAAAAAAAAAAAAAAAAcG',
    '/9oADAMBAAIQAxAAAAGJfIX0xV4JSrlF4fePgIWDBKAvD/8A/8QAGRAAAgMBAAAAAAAAAAAAAAAABAUAMzQQ/9oACAEBAAEFAoNQ',
    '1z8Goa5+DUNc8//EAB0RAAECBwAAAAAAAAAAAAAAAAABAgMFBzM1c7L/2gAIAQMBAT8BqJioexOXEvsFRMVD2Jy4l9g//8QAGhEA',
    'AgIDAAAAAAAAAAAAAAAAAAECBjE1cf/aAAgBAgEBPwGWCr65dZLBV9cus//EABcQAAMBAAAAAAAAAAAAAAAAAAACEHL/2gAIAQEA',
    'Bj8CFF1VF1VF1P/EABgQAQADAQAAAAAAAAAAAAAAALEAARCh/9oACAEBAAE/IYxnBL1jOCXrGcEvP//aAAwDAQACAAMAAAAQ9U9c',
    '/8QAGBEAAwEBAAAAAAAAAAAAAAAAAAExcRD/2gAIAQMBAT8QOstfOstZ/8QAFxEAAwEAAAAAAAAAAAAAAAAAAFHwEP/aAAgBAgEB',
    'PxAobyhs/8QAGBAAAwEBAAAAAAAAAAAAAAAAIGHwABD/2gAIAQEAAT8Q1TBjqYMdTdx//9k=',
  ].join(''),
};

const FIXTURE_CHROMIUM_CANVAS = {
  sha256: 'd92ba4a9bd788d6216f394644617af829c5a5fa1a169754c8efd301a2e3b1440',
  bytes: 888,
  source: 'Chromium canvas.toDataURL("image/jpeg",0.9) via executor-B acceptance harness',
  base64: [
    '/9j/4AAQSkZJRgABAQAAAQABAAD/4gHYSUNDX1BST0ZJTEUAAQEAAAHIAAAAAAQwAABtbnRyUkdCIFhZWiAH4AABAAEAAAAAAABh',
    'Y3NwAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAQAA9tYAAQAAAADTLQAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA',
    'AAAAAAAAAAAAAAAAAAAAAAAAAAlkZXNjAAAA8AAAACRyWFlaAAABFAAAABRnWFlaAAABKAAAABRiWFlaAAABPAAAABR3dHB0AAAB',
    'UAAAABRyVFJDAAABZAAAAChnVFJDAAABZAAAAChiVFJDAAABZAAAAChjcHJ0AAABjAAAADxtbHVjAAAAAAAAAAEAAAAMZW5VUwAA',
    'AAgAAAAcAHMAUgBHAEJYWVogAAAAAAAAb6IAADj1AAADkFhZWiAAAAAAAABimQAAt4UAABjaWFlaIAAAAAAAACSgAAAPhAAAts9Y',
    'WVogAAAAAAAA9tYAAQAAAADTLXBhcmEAAAAAAAQAAAACZmYAAPKnAAANWQAAE9AAAApbAAAAAAAAAABtbHVjAAAAAAAAAAEAAAAM',
    'ZW5VUwAAACAAAAAcAEcAbwBvAGcAbABlACAASQBuAGMALgAgADIAMAAxADb/2wBDAAMCAgMCAgMDAwMEAwMEBQgFBQQEBQoHBwYI',
    'DAoMDAsKCwsNDhIQDQ4RDgsLEBYQERMUFRUVDA8XGBYUGBIUFRT/2wBDAQMEBAUEBQkFBQkUDQsNFBQUFBQUFBQUFBQUFBQUFBQU',
    'FBQUFBQUFBQUFBQUFBQUFBQUFBQUFBQUFBQUFBQUFBT/wAARCAAYACADASIAAhEBAxEB/8QAFwAAAwEAAAAAAAAAAAAAAAAAAAYH',
    'Bf/EAB4QAAECBwEAAAAAAAAAAAAAAAACBAEGBzU2dLKC/8QAFQEBAQAAAAAAAAAAAAAAAAAACAf/xAAjEQABAgILAAAAAAAAAAAA',
    'AAAAAQIDNgQGBwgyNHFydLGz/9oADAMBAAIRAxEAPwCKD5LFjbeuoiGPksWNt66iTGLhKveJlSjchnnFMCquPN9pPCyVFVqrjzfa',
    'TwslQvLL5dbvf2D6r2RTVR4HyWLG29dRAAhxcIwbxMqUbkM84pgVVx5vtJ4WSoAF5ZfLrd7+wfVeyKaqf//Z',
  ].join(''),
};
/* Lead 生成：本仓库 fixture server + harness + 插件无头 Chromium，2026-11-04，
   canvas.toDataURL('image/jpeg', 0.95)，32×24 三竖条；含 ICC APP2 段。 */
const FIXTURE_CHROMIUM_LEAD = {
  sha256: '81120abbe03a0f672cfa49968f1fe5cab2be75062992a989330712a264781766',
  bytes: 898,
  base64: [
    '/9j/4AAQSkZJRgABAQAAAQABAAD/4gHYSUNDX1BST0ZJTEUAAQEAAAHIAAAAAAQwAABtbnRyUkdCIFhZWiAH4AABAAEAAAAAAABh',
    'Y3NwAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAQAA9tYAAQAAAADTLQAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA',
    'AAAAAAAAAAAAAAAAAAAAAAAAAAlkZXNjAAAA8AAAACRyWFlaAAABFAAAABRnWFlaAAABKAAAABRiWFlaAAABPAAAABR3dHB0AAAB',
    'UAAAABRyVFJDAAABZAAAAChnVFJDAAABZAAAAChiVFJDAAABZAAAAChjcHJ0AAABjAAAADxtbHVjAAAAAAAAAAEAAAAMZW5VUwAA',
    'AAgAAAAcAHMAUgBHAEJYWVogAAAAAAAAb6IAADj1AAADkFhZWiAAAAAAAABimQAAt4UAABjaWFlaIAAAAAAAACSgAAAPhAAAts9Y',
    'WVogAAAAAAAA9tYAAQAAAADTLXBhcmEAAAAAAAQAAAACZmYAAPKnAAANWQAAE9AAAApbAAAAAAAAAABtbHVjAAAAAAAAAAEAAAAM',
    'ZW5VUwAAACAAAAAcAEcAbwBvAGcAbABlACAASQBuAGMALgAgADIAMAAxADb/2wBDAAIBAQEBAQIBAQECAgICAgQDAgICAgUEBAME',
    'BgUGBgYFBgYGBwkIBgcJBwYGCAsICQoKCgoKBggLDAsKDAkKCgr/2wBDAQICAgICAgUDAwUKBwYHCgoKCgoKCgoKCgoKCgoKCgoK',
    'CgoKCgoKCgoKCgoKCgoKCgoKCgoKCgoKCgoKCgoKCgr/wAARCAAYACADASIAAhEBAxEB/8QAFgABAQEAAAAAAAAAAAAAAAAABwAI',
    '/8QAHhAAAQEJAAAAAAAAAAAAAAAAAAIEBwg2RoOEs8P/xAAWAQEBAQAAAAAAAAAAAAAAAAAJBwj/xAAlEQAAAwQLAAAAAAAAAAAA',
    'AAAAAwQBBTe0AgYICTM2cXWCg7L/2gAMAwEAAhEDEQA/AMvi07KR2G7tWEotOykdhu7VkKVYbNRoK8Tgo79wKllYN4uaey+IMjNF',
    'zT2XxBkTWzrBt2d8wcDpqPlZPz90gqC07KR2G7tWRBlKsNmoRa8Tgo79wKllYN4uaey+IMkQmtnWDbs75g4HTUfKyfn7pD//2Q==',
  ].join(''),
};
/* ------------------------------------------------------------------ */
/* 常量与契约形状                                                      */
/* ------------------------------------------------------------------ */

test('constants: T4/DC versions and required T4_LIMITS names', () => {
  assert.equal(T4_VERSION, 1);
  assert.equal(T4_ALGORITHM_VERSION, 't4-draft-v1');
  assert.equal(DC_ALGORITHM_VERSION, 'dc-draft-v1');
  const required = [
    'maxActiveSessions', 'retainedSessions', 'durationMs', 'durationMsHard', 'maxFrames', 'maxFramesHard',
    'maxBytes', 'maxBytesHard', 'maxFramePixels', 'maxFrameBytes', 'maxEvents', 'maxEventsHard',
    'maxRegions', 'maxEvidenceBytes', 'maxWorkingSetBytes', 'algorithmBudgetMs', 'correlationPageSize',
    'maxCandidateCompares', 'correlationBeforeMs', 'correlationAfterMs', 'maxCorrelationBeforeMs',
    'maxCorrelationAfterMs', 'maxCalibrationSamples', 'maxClockUncertaintyMs', 'recalibrateAfterMs',
    'maxImagesPerObserve', 'sampleIntervalMsMin', 'sampleIntervalMsMax', 'scaleMin', 'scaleMax',
    'maxControlTargets', 'maxAssertions', 'maxIds', 'maxMasks',
  ];
  for (const name of required) assert.equal(typeof T4_LIMITS[name], 'number', `T4_LIMITS.${name}`);
  assert.equal(T4_LIMITS.maxFrames, 180);
  assert.equal(T4_LIMITS.maxFramesHard, 300);
  assert.equal(T4_LIMITS.maxBytes, 33554432);
  assert.equal(T4_LIMITS.maxEvents, 5000);
  assert.equal(T4_LIMITS.maxClockUncertaintyMs, 10);
  assert.equal(T4_LIMITS.maxCandidateCompares, 40000);
  assert.equal(T4_LIMITS.durationMs, 3000);
  assert.equal(T4_LIMITS.durationMsHard, 60000);
  assert.equal(T4_LIMITS.maxSessionExtendMs, 60000);
  assert.equal(T4_LIMITS.sessionCapMs, 300000);
  assert.equal(T4_LIMITS.recalibrateAfterMs, 10000);
});

test('DC vocabulary: six directions, basis/grade map, confidence', () => {
  assert.deepEqual([...DC_DIRECTIONS], [
    'operation->visual', 'operation->network', 'network->visual',
    'visual->network', 'network->network', 'visual->visual',
  ]);
  assert.deepEqual([...DC_BASIS], ['explicit', 'redirect', 'initiator', 'observed', 'temporal']);
  assert.equal(DC_GRADE_MAP.explicit, 'confirmed-causal');
  assert.equal(DC_GRADE_MAP.redirect, 'confirmed-causal');
  assert.equal(DC_GRADE_MAP.initiator, 'confirmed-causal');
  assert.equal(DC_GRADE_MAP.observed, 'observed-association');
  assert.equal(DC_GRADE_MAP.temporal, 'temporal-proximity');
  assert.deepEqual([...DC_CONFIDENCE], ['direct', 'supported', 'weak', 'unknown']);
  assert.equal(MOTION_TYPES.length, 7);
});

/* ------------------------------------------------------------------ */
/* 帧存储：预算/淘汰/pin/丢弃/完整性                                    */
/* ------------------------------------------------------------------ */

function storeFrame(id, { timestamp = null, received = 1000, bytes = 10, width = 2, height = 2, image = null } = {}) {
  return {
    frameId: id,
    sourceTimestamp: timestamp,
    receivedMonoMs: received,
    encoding: 'png',
    bytes: new Uint8Array(bytes).fill(7),
    dimensions: { width, height },
    mapping: null,
    provenance: { producer: 'host', sourceKind: 'screencast', trust: 'host-observed' },
    image,
  };
}

test('store: eviction counts evicted and reports complete=false with gaps', () => {
  const store = new DynamicFrameStore({ scopeId: 's', dynamicSessionId: 'd', limits: { maxFrames: 3 }, now: () => 5000 });
  for (let index = 1; index <= 5; index += 1) {
    const result = store.addFrame(storeFrame(`f${index}`, { received: 1000 + index }));
    assert.equal(result.ok, true);
    assert.equal(result.seq, index);
  }
  assert.equal(store.size, 3);
  assert.equal(store.highWater, 5);
  const integrity = store.integrity();
  assert.equal(integrity.evicted, 2);
  assert.equal(integrity.captured, 5);
  assert.equal(integrity.retained, 3);
  assert.equal(integrity.complete, false);
  assert.deepEqual(integrity.gaps, [{ fromSeq: 1, toSeq: 2, reason: 'evicted' }]);
  assert.equal(store.getFrame('f3').frameId, 'f3');
  assert.throws(() => store.getFrame('f1'), (error) => error.code === 'DYNAMIC_EVENT_NOT_FOUND');
});

test('store: pin protects frame, then all-pinned insertion is dropped not thrown', () => {
  const store = new DynamicFrameStore({ scopeId: 's', dynamicSessionId: 'd', limits: { maxFrames: 2 }, now: () => 1 });
  store.addFrame(storeFrame('a'));
  store.addFrame(storeFrame('b'));
  assert.deepEqual(store.pin('a'), { frameId: 'a', pinned: true });
  const third = store.addFrame(storeFrame('c'));
  assert.equal(third.ok, true);
  assert.deepEqual(third.evicted, ['b']);
  assert.equal(store.size, 2);
  store.pin('c');
  const fourth = store.addFrame(storeFrame('d'));
  assert.deepEqual(fourth, { ok: false, frameId: null, seq: null, evicted: [], reason: 'queue-full' });
  assert.equal(store.size, 2);
  assert.equal(store.integrity().dropped, 1);
  assert.equal(store.integrity().complete, false);
  store.unpin('a');
  assert.equal(store.size, 2);
});

test('store: oversize and pixel budgets are dropped and counted, not thrown', () => {
  const store = new DynamicFrameStore({ scopeId: 's', dynamicSessionId: 'd', now: () => 1 });
  const oversize = store.addFrame({
    ...storeFrame('big'),
    bytes: new Uint8Array(T4_LIMITS.maxFrameBytes + 1),
  });
  assert.equal(oversize.ok, false);
  assert.equal(oversize.reason, 'oversize');
  const tooManyPixels = store.addFrame({
    ...storeFrame('pixels'),
    dimensions: { width: 2100, height: 2000 },
  });
  assert.equal(tooManyPixels.ok, false);
  assert.equal(tooManyPixels.reason, 'pixels');
  const integrity = store.integrity();
  assert.equal(integrity.dropped, 2);
  assert.equal(integrity.retained, 0);
  assert.ok(integrity.issues.some((issue) => issue.code === 'frame-bytes-exceeded'));
  assert.ok(integrity.issues.some((issue) => issue.code === 'frame-pixels-exceeded'));
});

test('store: frame evidence keeps sourceTimestamp null, separate encoded/rgba hashes', () => {
  const store = new DynamicFrameStore({ scopeId: 's', dynamicSessionId: 'd', now: () => 777 });
  const image = fillImage(2, 2, RED);
  const result = store.addFrame(storeFrame('f1', { timestamp: null, image }));
  assert.equal(result.ok, true);
  const record = store.getFrame('f1');
  assert.equal(record.sourceTimestamp, null);
  assert.equal(record.receivedMonoMs, 1000);
  assert.equal(typeof record.encodedSha256, 'string');
  assert.equal(record.sha256, record.encodedSha256);
  assert.equal(typeof record.rgbaSha256, 'string');
  assert.notEqual(record.encodedSha256, record.rgbaSha256);
  assert.equal(record.dimensions.width, 2);
  const integrity = store.integrity();
  assert.equal(integrity.coverage.missingSourceTimestamps, 1);
  assert.equal(integrity.coverage.unknownSourceDrops, null);
  assert.equal(integrity.coverage.decodeFailures, 0);
});

test('store: unknown and cross-session frame IDs share the same NOT_FOUND shape', () => {
  const store = new DynamicFrameStore({ scopeId: 's', dynamicSessionId: 'd', now: () => 1 });
  store.addFrame(storeFrame('f1'));
  const unknown = catchError(() => store.getFrame('nope'));
  const crossSession = catchError(() => store.addFrame({ ...storeFrame('x'), dynamicSessionId: 'other' }));
  assert.equal(unknown.code, 'DYNAMIC_EVENT_NOT_FOUND');
  assert.equal(crossSession.code, 'DYNAMIC_EVENT_NOT_FOUND');
  assert.deepEqual(unknown.details, crossSession.details);
  assert.equal(crossSession.details.idKind, 'frame');
  const pinUnknown = catchError(() => store.pin('nope'));
  assert.deepEqual(pinUnknown.details, unknown.details);
});

test('store: ack failures, marked gaps and window/sinceSeq queries', () => {
  const store = new DynamicFrameStore({ scopeId: 's', dynamicSessionId: 'd', limits: { maxFrames: 10 }, now: () => 9 });
  store.addFrame({ ...storeFrame('a', { received: 100 }), timelineMs: 100 });
  store.addFrame({ ...storeFrame('b', { received: 140 }), timelineMs: 140 });
  store.addFrame({ ...storeFrame('c', { received: 200 }), timelineMs: 200 });
  store.recordAck(true);
  store.recordAck(false);
  assert.equal(store.integrity().ackFailures, 1);
  store.markGap({ fromSeq: 2, toSeq: 2, reason: 'missed-tick' });
  const integrity = store.integrity();
  assert.equal(integrity.gaps.length, 1);
  assert.equal(integrity.gaps[0].reason, 'missed-tick');
  assert.equal(integrity.coverage.maxAdjacentIntervalMs, 60);
  const windowed = store.getFrames({ window: { fromMs: 130, toMs: 210 } });
  assert.deepEqual(windowed.map((item) => item.frameId), ['b', 'c']);
  const since = store.listFrames({ sinceSeq: 2 });
  assert.deepEqual(since.frames.map((item) => item.frameId), ['c']);
  assert.equal(since.cursor.next, null);
  assert.throws(() => store.listFrames({ frameIds: ['a'], window: { fromMs: 0, toMs: 10 } }),
    (error) => error.code === 'DYNAMIC_INVALID_ARGUMENT');
});

test('store: hard limits are refused at construction (explicit budget preflight)', () => {
  assert.throws(
    () => new DynamicFrameStore({ scopeId: 's', limits: { maxFrames: T4_LIMITS.maxFramesHard + 1 } }),
    (error) => error.code === 'DYNAMIC_LIMIT_EXCEEDED',
  );
  assert.throws(
    () => new DynamicFrameStore({ scopeId: 's', limits: { maxBytes: T4_LIMITS.maxBytesHard + 1 } }),
    (error) => error.code === 'DYNAMIC_LIMIT_EXCEEDED',
  );
});

/* ------------------------------------------------------------------ */
/* 事件日志 / 时间轴                                                   */
/* ------------------------------------------------------------------ */

test('log: seq monotonic, highWater and envelope defaults', () => {
  const log = new DynamicEventLog({ scopeId: 's', dynamicSessionId: 'd', now: () => 42 });
  const first = log.append({ domain: 'visual', kind: 'frame', ids: { frameId: 'fr1' }, ts: { timelineMs: 10 } });
  const second = log.append({ domain: 'network', kind: 'http', ts: { timelineMs: 10 } });
  assert.equal(first.seq, 1);
  assert.equal(second.seq, 2);
  assert.equal(log.highWater, 2);
  assert.equal(first.dynamicSessionId, 'd');
  assert.equal(first.scopeId, 's');
  assert.equal(first.ts.receivedMonoMs, 42);
  assert.equal(first.ts.sourceTimestamp, null);
  assert.equal(log.get(first.eventId).eventId, first.eventId);
  assert.equal(log.bySeq(2).eventId, second.eventId);
  assert.throws(() => log.append({ domain: 'visual', kind: 'frame', seq: 9 }), (error) => error.code === 'DYNAMIC_INVALID_ARGUMENT');
  assert.throws(() => log.get('missing'), (error) => error.code === 'DYNAMIC_EVENT_NOT_FOUND');
  assert.equal(log.sinceSeq(1, 10).length, 1);
});

test('log: capacity evicts oldest, records gaps, and keeps indexes in sync', () => {
  const log = new DynamicEventLog({
    scopeId: 's', dynamicSessionId: 'd', now: () => 1, limits: { maxEvents: 3 },
  });
  for (let index = 1; index <= 5; index += 1) {
    log.append({ domain: 'operation', kind: 'click', ts: { timelineMs: index * 10 } });
  }
  assert.equal(log.size, 3);
  assert.equal(log.highWater, 5);
  const integrity = log.integrity();
  assert.equal(integrity.evicted, 2);
  assert.equal(integrity.complete, false);
  assert.deepEqual(integrity.gaps, [{ fromSeq: 1, toSeq: 2 }]);
  assert.throws(() => log.bySeq(1), (error) => error.code === 'DYNAMIC_EVENT_NOT_FOUND');
  assert.equal(log.bySeq(3).seq, 3);
  const page = log.query({ sinceSeq: 3, limit: 1 });
  assert.equal(page.events.length, 1);
  assert.equal(page.truncated, true);
  assert.equal(typeof page.cursor.next, 'string');
  const next = log.query({ cursor: page.cursor.next, limit: 5 });
  assert.deepEqual(next.events.map((item) => item.seq), [5]);
});

test('log: rejections and hard event limit', () => {
  assert.throws(
    () => new DynamicEventLog({ scopeId: 's', limits: { maxEvents: T4_LIMITS.maxEventsHard + 1 } }),
    (error) => error.code === 'DYNAMIC_LIMIT_EXCEEDED',
  );
  const log = new DynamicEventLog({ scopeId: 's', dynamicSessionId: 'd', now: () => 1 });
  log.append({ domain: 'visual', kind: 'frame' });
  assert.throws(
    () => log.append({ domain: 'visual', kind: 'frame', dynamicSessionId: 'other' }),
    (error) => error.code === 'DYNAMIC_INVALID_ARGUMENT',
  );
  assert.throws(
    () => log.append({ domain: 'nope', kind: 'frame' }),
    (error) => error.code === 'DYNAMIC_INVALID_ARGUMENT',
  );
});

test('timeline: stable ordering by (timelineMs, seq, eventId), null time last', () => {
  const eventA = { eventId: 'b', seq: 2, ts: { timelineMs: 100 } };
  const eventB = { eventId: 'a', seq: 3, ts: { timelineMs: 100 } };
  const nullTime = { eventId: 'c', seq: 4, ts: { timelineMs: null } };
  const earlier = { eventId: 'z', seq: 1, ts: { timelineMs: 5 } };
  const sorted = sortTimeline([nullTime, eventB, eventA, earlier]);
  assert.deepEqual(sorted.map((item) => item.eventId), ['z', 'b', 'a', 'c']);
  assert.ok(compareTimelineEvents(eventA, eventB) < 0);
  assert.ok(compareTimelineEvents(eventB, nullTime) < 0);
});

/* ------------------------------------------------------------------ */
/* 时钟                                                                */
/* ------------------------------------------------------------------ */

test('clock: anchor midpoint offset, half-RTT uncertainty, negative delay rejected', () => {
  const anchor = createClockAnchor({ sendMonoMs: 1000, receiveMonoMs: 1100, pageNowMs: 500 });
  assert.equal(anchor.offsetMs, 550);
  assert.equal(anchor.uncertaintyMs, 50);
  assert.equal(anchor.sampleCount, 1);
  assert.equal(anchor.maxDeviationMs, 0);
  assert.equal(anchor.samples.length, 1);
  assert.throws(
    () => createClockAnchor({ sendMonoMs: 1100, receiveMonoMs: 1000, pageNowMs: 0 }),
    (error) => error.code === 'DYNAMIC_INVALID_ARGUMENT',
  );
});

test('clock: merge picks min RTT, keeps max deviation and sample count', () => {
  const merged = mergeClockAnchors([
    { offsetMs: 100, uncertaintyMs: 50, rttMs: 100, anchorId: 'a' },
    { offsetMs: 110, uncertaintyMs: 5, rttMs: 10, anchorId: 'b' },
    { offsetMs: 95, uncertaintyMs: 40, rttMs: 80, anchorId: 'c' },
  ]);
  assert.equal(merged.offsetMs, 110);
  assert.equal(merged.sampleCount, 3);
  assert.equal(merged.maxDeviationMs, 15);
  assert.equal(merged.uncertaintyMs, 15);
  assert.equal(merged.samples.length, 3);
});

test('clock: uncertainty > 10ms is uncertain; intervals overlap means no order', () => {
  assert.equal(isClockUncertain(10), false);
  assert.equal(isClockUncertain(10.5), true);
  assert.equal(isClockUncertain(null), true);
  assert.equal(isClockUncertain({ uncertaintyMs: 300 }), true);
  assert.equal(intervalsOverlap({ timelineMs: 100, uncertaintyMs: 10 }, { timelineMs: 105, uncertaintyMs: 10 }), true);
  assert.equal(intervalsOverlap({ timelineMs: 100, uncertaintyMs: 1 }, { timelineMs: 120, uncertaintyMs: 1 }), false);
  assert.equal(resolveOrder({ timelineMs: 100, uncertaintyMs: 10 }, { timelineMs: 105, uncertaintyMs: 10 }), 'indeterminate');
  assert.equal(resolveOrder({ timelineMs: 100, uncertaintyMs: 1 }, { timelineMs: 120, uncertaintyMs: 1 }), 'before');
});

test('clock: missing source timestamp stays null (screencast), clock-uncertain classified not thrown', () => {
  const missingAnchor = buildEventTime({ sourceTimestamp: 1700000000.5, receivedMonoMs: 500 });
  assert.equal(missingAnchor.sourceTimestamp, 1700000000.5);
  assert.equal(missingAnchor.timelineMs, 500);
  assert.equal(missingAnchor.timelineSource, 'received');
  assert.ok(missingAnchor.limitations.includes('missing-clock-anchor'));
  assert.ok(missingAnchor.classifications.includes('clock-uncertain'));
  assert.equal(missingAnchor.clockUncertain, true);

  const noSource = buildEventTime({ sourceTimestamp: null, receivedMonoMs: 500 });
  assert.equal(noSource.sourceTimestamp, null);
  assert.equal(noSource.timelineMs, 500);
  assert.ok(noSource.limitations.includes('source-time-missing'));

  const anchor = createClockAnchor({ sendMonoMs: 1000, receiveMonoMs: 1020, pageNowMs: 0 });
  const mapped = buildEventTime({ sourceTimestamp: 2, receivedMonoMs: 1000, anchor });
  assert.equal(mapped.timelineMs, 3010);
  assert.equal(mapped.timelineSource, 'source');
  assert.equal(mapped.clockUncertain, false);
  assert.ok(mapped.limitations.includes('clock-uncertainty-exceeds-10ms') === false);

  const regressed = buildEventTime({
    sourceTimestamp: 1.5, previousSourceTimestamp: 2, receivedMonoMs: 900, anchor,
  });
  assert.equal(regressed.clockUncertain, true);
  assert.ok(regressed.limitations.includes('source-time-regressed'));
});

/* ------------------------------------------------------------------ */
/* 七原语：frame-diff                                                  */
/* ------------------------------------------------------------------ */

test('frame-diff: identical frames PASS (no change), changed frames FAIL', () => {
  const unchanged = analyzeFrameDiff({ frames: solid(RED, RED) });
  assert.equal(unchanged.verdict, 'PASS');
  assert.ok(unchanged.reasons.includes('no-change'));
  assert.equal(unchanged.metrics.maxDiffRatio, 0);

  const changed = analyzeFrameDiff({ frames: solid(RED, BLUE) });
  assert.equal(changed.verdict, 'FAIL');
  assert.ok(changed.reasons.includes('change-detected'));
  assert.equal(changed.metrics.changedPairs, 1);
  assert.equal(changed.metrics.pairs[0].diffRatio, 1);
  assert.equal(changed.encoding, null);
  assert.equal(changed.precise, true);
});

test('frame-diff: missing intermediate frame makes the negative inconclusive', () => {
  const frames = solid(RED, RED);
  frames[1].seq = 3;
  frames[1].frameId = 'f3';
  const result = analyzeFrameDiff({ frames });
  assert.equal(result.verdict, 'INCONCLUSIVE');
  assert.ok(result.reasons.includes('missing-intermediate-frames'));
  assert.ok(result.limitations.includes('missing-intermediate-frames'));
});

test('frame-diff: explicit region fully covered by mask is a preflight invalid argument', () => {
  const frames = solid(RED, RED);
  const error = catchError(() => analyzeFrameDiff({
    frames,
    region: { x: 0, y: 0, width: 4, height: 4 },
    masks: [{ id: 'm', region: { x: 0, y: 0, width: 4, height: 4 } }],
  }));
  assert.equal(error.code, 'DYNAMIC_INVALID_ARGUMENT');
  assert.equal(error.details.reason, 'full-mask');
});

test('frame-diff: full-image mask without region becomes INCONCLUSIVE/empty-comparison, never similarity 1', () => {
  const frames = solid(RED, BLUE);
  const result = analyzeFrameDiff({
    frames,
    masks: [{ id: 'all', region: { x: 0, y: 0, width: 20, height: 20 } }],
  });
  assert.equal(result.verdict, 'INCONCLUSIVE');
  assert.ok(result.reasons.includes('empty-comparison'));
  assert.equal(result.metrics.errors[0].code, 'empty-comparison');
});

test('frame-diff: masks exclude pixels from denominator (C=N-M)', () => {
  const frames = solid(RED, BLUE);
  const result = analyzeFrameDiff({
    frames,
    region: { x: 0, y: 0, width: 20, height: 20 },
    masks: [{ id: 'half', region: { x: 0, y: 0, width: 10, height: 20 } }],
  });
  assert.equal(result.verdict, 'FAIL');
  assert.equal(result.metrics.pairs[0].comparedPixels, 200);
  assert.equal(result.metrics.pairs[0].maskPixels, 200);
  assert.equal(result.metrics.pairs[0].diffRatio, 1);
});

test('frame-diff: missing decoded image / size mismatch are inconclusive, not thrown', () => {
  const undecoded = analyzeFrameDiff({
    frames: [frame({ id: 'a', seq: 1, timelineMs: 0 }), frame({ id: 'b', seq: 2, timelineMs: 40 })],
  });
  assert.equal(undecoded.verdict, 'INCONCLUSIVE');
  assert.ok(undecoded.reasons.includes('decoder-unavailable'));

  const mismatched = analyzeFrameDiff({
    frames: [
      frame({ id: 'a', seq: 1, timelineMs: 0, image: fillImage(20, 20, RED) }),
      frame({ id: 'b', seq: 2, timelineMs: 40, image: fillImage(10, 10, RED) }),
    ],
  });
  assert.equal(mismatched.verdict, 'INCONCLUSIVE');
  assert.ok(mismatched.reasons.includes('size-mismatch'));
});

test('frame-diff: single frame is inconclusive (no pair to compare)', () => {
  const result = analyzeFrameDiff({ frames: solid(RED) });
  assert.equal(result.verdict, 'INCONCLUSIVE');
  assert.ok(result.reasons.includes('insufficient-samples'));
});

/* ------------------------------------------------------------------ */
/* 七原语：region-change                                               */
/* ------------------------------------------------------------------ */

test('region-change: changed region reported with bbox and area, verdict FAIL', () => {
  const base = fillImage(30, 30, BLACK);
  const changed = fillImage(30, 30, BLACK, [{ x: 5, y: 5, width: 10, height: 10, color: WHITE }]);
  const result = analyzeRegionChange({
    frames: [
      frame({ id: 'a', seq: 1, timelineMs: 0, image: base }),
      frame({ id: 'b', seq: 2, timelineMs: 40, image: changed }),
    ],
  });
  assert.equal(result.verdict, 'FAIL');
  assert.ok(result.reasons.includes('region-change-detected'));
  assert.equal(result.metrics.regions.length, 1);
  assert.equal(result.metrics.regions[0].area, 100);
  assert.deepEqual(result.metrics.regions[0].region, { x: 5, y: 5, width: 10, height: 10 });
});

test('region-change: sub-threshold area yields PASS/below-change-ratio; none yields PASS/no-region-change', () => {
  const base = fillImage(30, 30, BLACK);
  const small = fillImage(30, 30, BLACK, [{ x: 0, y: 0, width: 4, height: 1, color: WHITE }]);
  const subThreshold = analyzeRegionChange({
    frames: [
      frame({ id: 'a', seq: 1, timelineMs: 0, image: base }),
      frame({ id: 'b', seq: 2, timelineMs: 40, image: small }),
    ],
  });
  assert.equal(subThreshold.verdict, 'PASS');
  assert.ok(subThreshold.reasons.includes('below-change-ratio'));
  assert.equal(subThreshold.metrics.regions.length, 1);
  assert.equal(subThreshold.metrics.regions[0].area, 4);

  const none = analyzeRegionChange({ frames: solid(BLACK, BLACK) });
  assert.equal(none.verdict, 'PASS');
  assert.ok(none.reasons.includes('no-region-change'));
});

test('region-change: minArea filter drops tiny regions', () => {
  const base = fillImage(30, 30, BLACK);
  const tiny = fillImage(30, 30, BLACK, [{ x: 0, y: 0, width: 1, height: 1, color: WHITE }]);
  const result = analyzeRegionChange({
    frames: [
      frame({ id: 'a', seq: 1, timelineMs: 0, image: base }),
      frame({ id: 'b', seq: 2, timelineMs: 40, image: tiny }),
    ],
    thresholds: { minArea: 4 },
  });
  assert.equal(result.metrics.regions.length, 0);
  assert.equal(result.verdict, 'PASS');
});

/* ------------------------------------------------------------------ */
/* 七原语：flicker                                                     */
/* ------------------------------------------------------------------ */

test('flicker: A→B→A within 100ms is FAIL/flicker-detected', () => {
  const result = analyzeFlicker({ frames: solid(RED, WHITE, RED) });
  assert.equal(result.verdict, 'FAIL');
  assert.ok(result.reasons.includes('flicker-detected'));
  assert.equal(result.metrics.candidates.length, 1);
  assert.equal(result.metrics.candidates[0].durationMs, 40);
  assert.ok(result.metrics.candidates[0].brightnessDelta >= 64);
});

test('flicker: stable frames PASS/no-flicker; two frames never claim no flicker', () => {
  const stable = analyzeFlicker({ frames: solid(RED, RED, RED) });
  assert.equal(stable.verdict, 'PASS');
  assert.ok(stable.reasons.includes('no-flicker'));

  const two = analyzeFlicker({ frames: solid(RED, RED) });
  assert.equal(two.verdict, 'INCONCLUSIVE');
  assert.ok(two.reasons.includes('insufficient-samples'));
});

test('flicker: missing time yields INCONCLUSIVE, not a false negative', () => {
  const frames = solid(RED, WHITE, RED).map((item) => ({ ...item, timelineMs: null, receivedMonoMs: null }));
  const result = analyzeFlicker({ frames });
  assert.equal(result.verdict, 'INCONCLUSIVE');
  assert.ok(result.reasons.includes('missing-time'));
  assert.equal(result.metrics.unverifiedTime.length, 1);
});

test('flicker: B too long or too dim does not count as flicker', () => {
  const slow = analyzeFlicker({ frames: solidFrames(20, 20, [RED, WHITE, RED], { stepMs: 300 }) });
  assert.equal(slow.verdict, 'PASS');
  assert.ok(slow.reasons.includes('flicker-too-long'));

  const dim = analyzeFlicker({ frames: solid(RED, [200, 0, 0, 255], RED) });
  assert.equal(dim.verdict, 'PASS');
  assert.ok(dim.reasons.includes('brightness-below-threshold'));
});

test('flicker: detected flicker across missing intermediate frames keeps FAIL with limitation', () => {
  const frames = solid(RED, WHITE, RED);
  frames[1].seq = 3;
  frames[2].seq = 4;
  const result = analyzeFlicker({ frames });
  assert.equal(result.verdict, 'FAIL');
  assert.ok(result.limitations.includes('missing-intermediate-frames'));
});

/* ------------------------------------------------------------------ */
/* 七原语：freeze                                                      */
/* ------------------------------------------------------------------ */

test('freeze: static ≥500ms with verified expectation is FAIL/freeze-detected', () => {
  const frames = solidFrames(20, 20, [RED, RED, RED, RED], { startMs: 0, stepMs: 200 });
  const result = analyzeFreeze({
    frames,
    expectation: frozenExpectation(),
    events: advancingEvents(),
  });
  assert.equal(result.verdict, 'FAIL');
  assert.ok(result.reasons.includes('freeze-detected'));
  assert.equal(result.metrics.runs[0].sampleCount, 4);
  assert.ok(result.metrics.runs[0].durationMs >= 500);
  assert.equal(result.encoding, null);
});

test('freeze: missing expectation is a preflight invalid argument', () => {
  const error = catchError(() => analyzeFreeze({ frames: solid(RED, RED, RED) }));
  assert.equal(error.code, 'DYNAMIC_INVALID_ARGUMENT');
});

test('freeze: unverifiable expectation stays INCONCLUSIVE (no self-proof)', () => {
  const frames = solidFrames(20, 20, [RED, RED, RED], { stepMs: 300 });
  const missingEvent = analyzeFreeze({
    frames,
    expectation: frozenExpectation(),
    events: [event({ eventId: 'ev-expect', domain: 'control', kind: 'pause' })],
  });
  assert.equal(missingEvent.verdict, 'INCONCLUSIVE');
  assert.ok(missingEvent.reasons.includes('reference-event-missing'));

  const callerOnly = analyzeFreeze({
    frames,
    expectation: frozenExpectation(),
    events: [
      event({ eventId: 'ev-expect', domain: 'control', kind: 'pause' }),
      event({
        eventId: 'ev-ref',
        domain: 'marker',
        kind: 'clock-advance',
        provenance: { producer: 'page', sourceKind: 'page-js', trust: 'caller-declared' },
      }),
    ],
  });
  assert.equal(callerOnly.verdict, 'INCONCLUSIVE');
  assert.ok(callerOnly.reasons.includes('advancing-evidence-unverified'));

  const viaAdvancingEvidence = analyzeFreeze({
    frames,
    expectation: frozenExpectation(),
    advancingEvidence: [
      { eventId: 'ev-expect', trust: 'host-observed' },
      { eventId: 'ev-ref', trust: 'host-observed' },
    ],
  });
  assert.equal(viaAdvancingEvidence.verdict, 'FAIL');
});

test('freeze: moving pixels PASS/no-freeze; too-short stability PASS with reason', () => {
  const moving = analyzeFreeze({
    frames: solidFrames(20, 20, [RED, BLUE, GREEN, WHITE], { stepMs: 200 }),
    expectation: frozenExpectation(),
    events: advancingEvents(),
  });
  assert.equal(moving.verdict, 'PASS');
  assert.ok(moving.reasons.includes('no-freeze'));

  const short = analyzeFreeze({
    frames: solidFrames(20, 20, [RED, RED, RED], { stepMs: 100 }),
    expectation: frozenExpectation(),
    events: advancingEvents(),
  });
  assert.equal(short.verdict, 'PASS');
  assert.ok(short.reasons.includes('stable-duration-too-short'));
});

test('freeze: control pause in the interval is INCONCLUSIVE/control-excluded', () => {
  const frames = solidFrames(20, 20, [RED, RED, RED, RED], { stepMs: 200 });
  const events = [
    ...advancingEvents(),
    event({
      eventId: 'ev-pause', domain: 'control', kind: 'pause', phase: 'applied',
      ts: { timelineMs: 200 }, payload: { targetId: 'anim' },
    }),
  ];
  const result = analyzeFreeze({ frames, expectation: frozenExpectation(), events });
  assert.equal(result.verdict, 'INCONCLUSIVE');
  assert.ok(result.reasons.includes('control-excluded'));
  assert.ok(result.classifications.includes('control-excluded'));
});

test('freeze: JPEG positive freeze stays FAIL (precise=false); JPEG negative is INCONCLUSIVE', () => {
  const frames = solidFrames(20, 20, [RED, RED, RED, RED], { stepMs: 200, encoding: 'jpeg' });
  const frozen = analyzeFreeze({ frames, expectation: frozenExpectation(), events: advancingEvents() });
  assert.equal(frozen.verdict, 'FAIL');
  assert.equal(frozen.encoding, 'jpeg');
  assert.equal(frozen.precise, false);
  assert.ok(frozen.limitations.includes('jpeg-compression-noise'));

  const moving = solidFrames(20, 20, [RED, BLUE, GREEN, WHITE], { stepMs: 200, encoding: 'jpeg' });
  const notFrozen = analyzeFreeze({ frames: moving, expectation: frozenExpectation(), events: advancingEvents() });
  assert.equal(notFrozen.verdict, 'INCONCLUSIVE');
  assert.ok(notFrozen.reasons.includes('jpeg-non-precise'));
});

/* ------------------------------------------------------------------ */
/* 七原语：jank（不需要像素）                                           */
/* ------------------------------------------------------------------ */

function jankFrames(times, { seqStart = 1, withImages = false } = {}) {
  return times.map((time, index) => frame({
    id: `j${seqStart + index}`,
    seq: seqStart + index,
    timelineMs: time,
    receivedMonoMs: 10_000 + time,
    image: withImages ? fillImage(4, 4, RED) : null,
  }));
}

test('jank: intervals without pixels (U-DV12) detect 2x expected interval', () => {
  const result = analyzeJank({
    frames: jankFrames([0, 40, 80, 200]),
    expectedIntervalMs: 40,
  });
  assert.equal(result.verdict, 'FAIL');
  assert.ok(result.reasons.includes('jank-detected'));
  assert.equal(result.metrics.suspectedCount, 1);
  assert.equal(result.metrics.p50, 40);
  assert.equal(result.metrics.max, 120);
  assert.deepEqual(result.metrics.intervals.map((item) => item.intervalMs), [40, 40, 120]);
});

test('jank: normal cadence PASS, missing expectedIntervalMs is invalid', () => {
  const normal = analyzeJank({ frames: jankFrames([0, 40, 80, 120]), expectedIntervalMs: 40 });
  assert.equal(normal.verdict, 'PASS');
  assert.ok(normal.reasons.includes('no-jank'));
  assert.throws(() => analyzeJank({ frames: jankFrames([0, 40]), expectedIntervalMs: undefined }),
    (error) => error.code === 'DYNAMIC_INVALID_ARGUMENT');
  assert.throws(() => analyzeJank({ frames: jankFrames([0, 40]), expectedIntervalMs: 0 }),
    (error) => error.code === 'DYNAMIC_INVALID_ARGUMENT');
});

test('jank: suspected interval coinciding with a missing frame is WARN/capture-jitter-only', () => {
  const result = analyzeJank({
    frames: jankFrames([0, 40, 200], { seqStart: 1 }),
    expectedIntervalMs: 40,
  });
  // manually create the seq gap 2 -> 4
  result.metrics.intervals[1].cause = 'capture-gap';
  const gapped = analyzeJank({
    frames: [
      frame({ id: 'a', seq: 1, timelineMs: 0 }),
      frame({ id: 'b', seq: 2, timelineMs: 40 }),
      frame({ id: 'c', seq: 4, timelineMs: 200 }),
    ],
    expectedIntervalMs: 40,
  });
  assert.equal(gapped.verdict, 'WARN');
  assert.ok(gapped.reasons.includes('capture-jitter-only'));
});

test('jank: incomplete integrity with no suspected interval is INCONCLUSIVE', () => {
  const result = analyzeJank({
    frames: jankFrames([0, 40, 80]),
    expectedIntervalMs: 40,
    integrity: { ...integrityComplete(), complete: false, ackFailures: 2 },
  });
  assert.equal(result.verdict, 'INCONCLUSIVE');
  assert.ok(result.reasons.includes('integrity-incomplete'));
});

test('jank: missing time is INCONCLUSIVE, not a false PASS', () => {
  const result = analyzeJank({
    frames: [
      frame({ id: 'a', seq: 1 }),
      frame({ id: 'b', seq: 2 }),
    ],
    expectedIntervalMs: 40,
  });
  assert.equal(result.verdict, 'INCONCLUSIVE');
  assert.ok(result.reasons.includes('missing-time'));
});

/* ------------------------------------------------------------------ */
/* 七原语：trajectory                                                  */
/* ------------------------------------------------------------------ */

function trajectoryFrames(positions, { size = 40, square = 6, color = [255, 0, 0, 255] } = {}) {
  return positions.map((position, index) => frame({
    id: `t${index + 1}`,
    seq: index + 1,
    timelineMs: index * 40,
    image: fillImage(size, size, BLACK, [{ x: position, y: position, width: square, height: square, color }]),
  }));
}

test('trajectory: unique consistent candidates PASS with steps', () => {
  const result = analyzeTrajectory({
    frames: trajectoryFrames([2, 6, 10]),
    query: { method: 'color', color: [255, 0, 0], tolerance: 16, minArea: 4 },
  });
  assert.equal(result.verdict, 'PASS');
  assert.equal(result.metrics.steps.length, 2);
  assert.ok(result.metrics.steps.every((step) => step.distance <= 80));
});

test('trajectory: jump beyond maxStep is FAIL; ambiguous candidates are INCONCLUSIVE', () => {
  const jump = analyzeTrajectory({
    frames: trajectoryFrames([0, 35]),
    query: { method: 'color', color: [255, 0, 0], tolerance: 16, minArea: 4 },
    thresholds: { maxStep: 10 },
  });
  assert.equal(jump.verdict, 'FAIL');
  assert.ok(jump.reasons.includes('step-exceeded'));

  const ambiguous = analyzeTrajectory({
    frames: [
      frame({
        id: 'a', seq: 1, timelineMs: 0,
        image: fillImage(40, 40, BLACK, [
          { x: 2, y: 2, width: 6, height: 6, color: [255, 0, 0, 255] },
          { x: 20, y: 20, width: 6, height: 6, color: [255, 0, 0, 255] },
        ]),
      }),
      frame({
        id: 'b', seq: 2, timelineMs: 40,
        image: fillImage(40, 40, BLACK, [
          { x: 4, y: 4, width: 6, height: 6, color: [255, 0, 0, 255] },
          { x: 22, y: 22, width: 6, height: 6, color: [255, 0, 0, 255] },
        ]),
      }),
    ],
    query: { method: 'color', color: [255, 0, 0], tolerance: 16, minArea: 4 },
  });
  assert.equal(ambiguous.verdict, 'INCONCLUSIVE');
  assert.ok(ambiguous.reasons.includes('candidate-ambiguous'));
  assert.equal(ambiguous.unresolved.length, 2);
  assert.equal(ambiguous.unresolved[0].candidateIds.length, 2);
});

test('trajectory: missing candidate, template without image, mapping mismatch', () => {
  const missing = analyzeTrajectory({
    frames: [
      ...trajectoryFrames([2]),
      frame({ id: 't2', seq: 2, timelineMs: 40, image: fillImage(40, 40, BLACK) }),
    ],
    query: { method: 'color', color: [255, 0, 0], tolerance: 16, minArea: 4 },
  });
  assert.equal(missing.verdict, 'INCONCLUSIVE');
  assert.ok(missing.reasons.includes('candidate-missing'));

  const template = analyzeTrajectory({
    frames: trajectoryFrames([2, 3]),
    query: { method: 'template', productId: `v1_${'a'.repeat(32)}` },
  });
  assert.equal(template.verdict, 'INCONCLUSIVE');
  assert.ok(template.reasons.includes('template-unavailable'));

  const mapping = analyzeTrajectory({
    frames: trajectoryFrames([2, 3]).map((item, index) => ({
      ...item,
      mapping: {
        coordinateSpace: 'document',
        originCss: { x: index * 100, y: 0 },
        cssPerPixel: { x: 1, y: 1 },
        capturedCssRect: { x: index * 100, y: 0, width: 40, height: 40 },
      },
    })),
    query: { method: 'color', color: [255, 0, 0], tolerance: 16, minArea: 4 },
  });
  assert.equal(mapping.verdict, 'INCONCLUSIVE');
  assert.ok(mapping.reasons.includes('mapping-incompatible'));
  assert.ok(mapping.classifications.includes('mapping-incompatible'));
});

/* ------------------------------------------------------------------ */
/* 七原语：transition                                                  */
/* ------------------------------------------------------------------ */

test('transition: completed onset + 3 stable samples is PASS with sampling interval', () => {
  const frames = solid(BLACK, BLACK, WHITE, WHITE, WHITE, WHITE);
  const result = analyzeTransition({ frames });
  assert.equal(result.verdict, 'PASS');
  assert.ok(result.reasons.includes('transition-observed'));
  assert.equal(result.transition.samplingInterval.fromFrameId, 'f2');
  assert.equal(result.transition.samplingInterval.toFrameId, 'f6');
  assert.equal(result.transition.samplingInterval.durationMs, 160);
  assert.equal(result.transition.samplingInterval.stableSamples, 3);
});

test('transition: no onset and never stable are INCONCLUSIVE', () => {
  const none = analyzeTransition({ frames: solid(BLACK, BLACK, BLACK, BLACK, BLACK) });
  assert.equal(none.verdict, 'INCONCLUSIVE');
  assert.ok(none.reasons.includes('no-transition'));

  const unstable = analyzeTransition({ frames: solid(BLACK, WHITE, BLACK, WHITE, BLACK, WHITE) });
  assert.equal(unstable.verdict, 'INCONCLUSIVE');
  assert.ok(unstable.reasons.includes('stability-not-reached'));
});

test('transition: JPEG completion is not precise → INCONCLUSIVE', () => {
  const frames = solid(BLACK, BLACK, WHITE, WHITE, WHITE, WHITE).map((item) => ({ ...item, encoding: 'jpeg' }));
  const result = analyzeTransition({ frames });
  assert.equal(result.verdict, 'INCONCLUSIVE');
  assert.ok(result.reasons.includes('jpeg-non-precise'));
});

/* ------------------------------------------------------------------ */
/* 断言批处理                                                          */
/* ------------------------------------------------------------------ */

test('validateMotionAssertions: ids unique, enum, inapplicable fields rejected', () => {
  assert.throws(() => validateMotionAssertions([]), (error) => error.code === 'DYNAMIC_INVALID_ARGUMENT');
  assert.throws(() => validateMotionAssertions([
    { id: 'a', type: 'frame-diff' },
    { id: 'a', type: 'frame-diff' },
  ]), (error) => error.code === 'DYNAMIC_INVALID_ARGUMENT');
  assert.throws(() => validateMotionAssertions([{ id: 'a', type: 'nope' }]),
    (error) => error.code === 'DYNAMIC_INVALID_ARGUMENT');
  assert.throws(() => validateMotionAssertions([{ id: 'a', type: 'frame-diff', expectedIntervalMs: 40 }]),
    (error) => error.code === 'DYNAMIC_INVALID_ARGUMENT');
  assert.throws(() => validateMotionAssertions([{ id: 'a', type: 'frame-diff', query: { method: 'color', color: [1, 2, 3] } }]),
    (error) => error.code === 'DYNAMIC_INVALID_ARGUMENT');
  assert.throws(() => validateMotionAssertions([{ id: 'a', type: 'jank' }]),
    (error) => error.code === 'DYNAMIC_INVALID_ARGUMENT');
  assert.throws(() => validateMotionAssertions([{ id: 'a', type: 'freeze' }]),
    (error) => error.code === 'DYNAMIC_INVALID_ARGUMENT');
  const ok = validateMotionAssertions([
    { id: 'a', type: 'jank', expectedIntervalMs: 40 },
    { id: 'b', type: 'freeze', expectation: frozenExpectation() },
    { id: 'c', type: 'transition', thresholds: { stableSamples: 2 } },
  ]);
  assert.equal(ok.length, 3);
  assert.equal(ok[0].thresholds.intervalFactor, 2);
  assert.equal(ok[2].thresholds.stableSamples, 2);
});

test('runMotionAssertions: summary/verdict/exitCode precedence and results order', () => {
  const frames = solid(BLACK, BLACK, WHITE, WHITE, WHITE, WHITE);
  const result = runMotionAssertions({
    frames,
    assertions: [
      { id: 'a', type: 'transition' },
      { id: 'b', type: 'frame-diff' },
    ],
  });
  assert.deepEqual(result.results.map((item) => item.id), ['a', 'b']);
  assert.equal(result.summary.total, 2);
  assert.equal(result.summary.pass, 1);
  assert.equal(result.summary.fail, 1);
  assert.equal(result.verdict, 'FAIL');
  assert.equal(result.exitCode, 1);
  assert.equal(result.ok, false);
  assert.equal(result.algorithmVersion, T4_ALGORITHM_VERSION);
});

test('runMotionAssertions: inconclusive-only is exit 2, empty frames BLOCKED', () => {
  const inconclusive = runMotionAssertions({
    frames: solid(RED),
    assertions: [{ id: 'a', type: 'frame-diff' }],
  });
  assert.equal(inconclusive.verdict, 'INCONCLUSIVE');
  assert.equal(inconclusive.exitCode, 2);

  const blocked = runMotionAssertions({
    frames: [],
    assertions: [{ id: 'a', type: 'frame-diff' }],
  });
  assert.equal(blocked.verdict, 'BLOCKED');
  assert.equal(blocked.exitCode, 2);
  assert.equal(blocked.results[0].status, 'blocked');
  assert.ok(blocked.results[0].reasons.includes('no-frames'));
});

test('runMotionAssertions: integrity is echoed, otherwise honest complete=false', () => {
  const snapshot = integrityComplete();
  const echoed = runMotionAssertions({
    frames: solid(BLACK, WHITE),
    assertions: [{ id: 'a', type: 'frame-diff' }],
    integrity: snapshot,
  });
  assert.deepEqual(echoed.integrity, snapshot);
  const missing = runMotionAssertions({
    frames: solid(BLACK, WHITE),
    assertions: [{ id: 'a', type: 'frame-diff' }],
  });
  assert.equal(missing.integrity.complete, false);
  assert.equal(missing.integrity.issueS ?? missing.integrity.issues[0].code, 'integrity-not-provided');
});

test('runMotionAssertions: frameIds/window selection and mutual exclusion', () => {
  const frames = solidFrames(20, 20, [BLACK, WHITE, BLACK], { stepMs: 100, startMs: 0 });
  const byId = runMotionAssertions({
    frames,
    assertions: [{ id: 'a', type: 'frame-diff' }],
    frameIds: ['f1', 'f3'],
  });
  // f1 -> f3 is not consecutive in the selected evidence set; still compared as adjacent frames.
  assert.equal(byId.results.length, 1);
  assert.equal(byId.results[0].sampleCount, 2);
  const byWindow = runMotionAssertions({
    frames,
    assertions: [{ id: 'a', type: 'frame-diff' }],
    window: { fromMs: 90, toMs: 210 },
  });
  assert.equal(byWindow.results[0].sampleCount, 2);
  assert.throws(() => runMotionAssertions({
    frames,
    assertions: [{ id: 'a', type: 'frame-diff' }],
    frameIds: ['f1'],
    window: { fromMs: 0, toMs: 10 },
  }), (error) => error.code === 'DYNAMIC_INVALID_ARGUMENT');
  assert.throws(() => runMotionAssertions({
    frames,
    assertions: [{ id: 'a', type: 'frame-diff' }],
    frameIds: ['missing'],
  }), (error) => error.code === 'DYNAMIC_EVENT_NOT_FOUND');
});

test('runMotionAssertions: uncertain clock downgrades timing assertions (not thrown)', () => {
  const frames = solidFrames(20, 20, [RED, RED, RED, RED], { stepMs: 200 });
  const anchor = createClockAnchor({ sendMonoMs: 0, receiveMonoMs: 100, pageNowMs: 0 }); // 50ms > 10ms
  const result = runMotionAssertions({
    frames,
    assertions: [
      { id: 'f', type: 'freeze', expectation: frozenExpectation() },
      { id: 'd', type: 'frame-diff' },
    ],
    events: advancingEvents(),
    clockAnchor: anchor,
  });
  const freeze = result.results.find((item) => item.id === 'f');
  assert.equal(freeze.verdict, 'INCONCLUSIVE');
  assert.ok(freeze.reasons.includes('clock-uncertain'));
  assert.ok(freeze.classifications.includes('clock-uncertain'));
  const diff = result.results.find((item) => item.id === 'd');
  assert.notEqual(diff.verdict, 'INCONCLUSIVE');
  assert.ok(diff.classifications.includes('clock-uncertain'));
});

/* ------------------------------------------------------------------ */
/* DC：basis/grade/confidence、过滤、隔离                              */
/* ------------------------------------------------------------------ */

function opVisualSources() {
  const op = event({
    eventId: 'ev-op', ids: { actionId: 'act-1', opId: 'op-1' }, ts: { timelineMs: 100 },
  });
  const visual = visualEvent({
    eventId: 'ev-vis', payload: { causeOpId: 'op-1' }, ts: { timelineMs: 150 },
  });
  return {
    operation: { events: [op], integrity: integrityComplete(), highWater: 1 },
    visual: { events: [visual], integrity: integrityComplete(), highWater: 1 },
    network: null,
  };
}

test('DC: explicit declared link is confirmed-causal/direct, observed cause stays observed', () => {
  const sources = opVisualSources();
  const marker = event({
    eventId: 'ev-link',
    domain: 'marker',
    kind: 'link',
    phase: null,
    ts: { timelineMs: 160 },
    payload: {
      link: { fromEventId: 'ev-op', toEventId: 'ev-vis', basis: 'explicit', verified: true, producer: 'host' },
    },
  });
  sources.operation.events.push(marker);
  const result = correlateDynamic({ dynamicSessionId: 'ds-1', sources });
  const explicit = result.pairs.find((pair) => pair.basis === 'explicit');
  assert.ok(explicit);
  assert.equal(explicit.grade, 'confirmed-causal');
  assert.equal(explicit.confidence, 'direct');
  assert.equal(explicit.direction, 'operation->visual');
  assert.ok(explicit.joinKeys.every((key) => typeof key.valueHash === 'string' && key.sourceEventIds.length === 2));
  assert.ok(explicit.evidenceIds.includes('ev-op'));
  assert.ok(explicit.evidenceIds.includes('ev-vis'));

  const observedOnly = correlateDynamic({ dynamicSessionId: 'ds-1', sources: opVisualSources() });
  const observed = observedOnly.pairs.find((pair) => pair.direction === 'operation->visual');
  assert.equal(observed.basis, 'observed');
  assert.equal(observed.grade, 'observed-association');
  assert.equal(observed.confidence, 'supported');
  assert.ok(observed.limitations.includes('page-declared-cause'));
  assert.equal(observedOnly.verdict.status, 'INCONCLUSIVE');
  assert.equal(observedOnly.verdict.reason, 'no-assertion');
  assert.equal(observedOnly.version, T4_VERSION);
  assert.equal(observedOnly.algorithmVersion, DC_ALGORITHM_VERSION);
});

test('DC: unverified declared link stays unresolved and never becomes confirmed', () => {
  const sources = opVisualSources();
  sources.operation.events.push(event({
    eventId: 'ev-link',
    domain: 'marker',
    kind: 'link',
    payload: { link: { fromEventId: 'ev-op', toEventId: 'ev-vis', basis: 'explicit', verified: false } },
  }));
  const result = correlateDynamic({ dynamicSessionId: 'ds-1', sources });
  assert.equal(result.pairs.some((pair) => pair.basis === 'explicit'), false);
  const unresolved = result.unresolved.find((item) => item.reason === 'declared-link-unverified');
  assert.ok(unresolved);
  assert.equal(unresolved.eventId, 'ev-vis');
  assert.equal(unresolved.declaredLink.verified, false);
});

test('DC: redirect and initiator are protocol confirmed-causal; script stack alone is unresolved', () => {
  const from = networkEvent({
    eventId: 'ev-req-1',
    ids: { requestKey: requestKey('1000.1') },
    ts: { timelineMs: 100 },
    seq: 1,
  });
  const redirected = networkEvent({
    eventId: 'ev-req-2',
    ids: { requestKey: requestKey('1000.2', { hopId: 1 }) },
    ts: { timelineMs: 120 },
    seq: 2,
    payload: { redirectFromRequestKey: requestKeyString(requestKey('1000.1')) },
  });
  const initiated = networkEvent({
    eventId: 'ev-req-3',
    ids: { requestKey: requestKey('1000.3') },
    ts: { timelineMs: 140 },
    seq: 3,
    payload: { initiator: { requestKey: requestKeyString(requestKey('1000.1')) } },
  });
  const scriptOnly = networkEvent({
    eventId: 'ev-req-4',
    ids: { requestKey: requestKey('1000.4') },
    ts: { timelineMs: 160 },
    seq: 4,
    payload: { initiator: { url: 'http://127.0.0.1/app.js', functionName: 'fetchData' } },
  });
  const result = correlateDynamic({
    dynamicSessionId: 'ds-1',
    directions: ['network->network'],
    sources: {
      operation: null,
      visual: null,
      network: { events: [from, redirected, initiated, scriptOnly], integrity: integrityComplete(), highWater: 4 },
    },
  });
  const redirect = result.pairs.find((pair) => pair.fromEventId === 'ev-req-1' && pair.toEventId === 'ev-req-2');
  assert.equal(redirect.basis, 'redirect');
  assert.equal(redirect.grade, 'confirmed-causal');
  const initiator = result.pairs.find((pair) => pair.toEventId === 'ev-req-3');
  assert.equal(initiator.basis, 'initiator');
  assert.equal(initiator.grade, 'confirmed-causal');
  assert.equal(result.pairs.some((pair) => pair.toEventId === 'ev-req-4'), false);
  assert.ok(result.unresolved.some((item) => item.eventId === 'ev-req-4' && item.reason === 'initiator-parent-missing'));
});

test('DC: shared trace is observed/weak, never confirmed-causal', () => {
  const first = networkEvent({
    eventId: 'ev-t1', seq: 1, ts: { timelineMs: 100 },
    ids: { requestKey: requestKey('t1'), traceIdHash: 'trace-abc' },
  });
  const second = networkEvent({
    eventId: 'ev-t2', seq: 2, ts: { timelineMs: 140 },
    ids: { requestKey: requestKey('t2'), traceIdHash: 'trace-abc' },
  });
  const result = correlateDynamic({
    dynamicSessionId: 'ds-1',
    directions: ['network->network'],
    sources: {
      operation: null, visual: null,
      network: { events: [first, second], integrity: integrityComplete(), highWater: 2 },
    },
  });
  const pair = result.pairs.find((item) => item.reasons.includes('shared-trace'));
  assert.ok(pair);
  assert.equal(pair.basis, 'observed');
  assert.equal(pair.grade, 'observed-association');
  assert.equal(pair.confidence, 'weak');
});

test('DC: temporal pairs are filtered by default and counted as suppressedTemporal', () => {
  const op = event({ eventId: 'ev-op', ids: { actionId: 'act-1' }, ts: { timelineMs: 100 } });
  const visual = visualEvent({ eventId: 'ev-vis', ts: { timelineMs: 130 } });
  const sources = {
    operation: { events: [op], integrity: integrityComplete(), highWater: 1 },
    visual: { events: [visual], integrity: integrityComplete(), highWater: 1 },
    network: null,
  };
  const filtered = correlateDynamic({ dynamicSessionId: 'ds-1', sources });
  assert.equal(filtered.pairs.some((pair) => pair.basis === 'temporal'), false);
  assert.ok(filtered.suppressedTemporal >= 1);

  const included = correlateDynamic({ dynamicSessionId: 'ds-1', sources, includeTemporal: true });
  const temporal = included.pairs.find((pair) => pair.basis === 'temporal');
  assert.ok(temporal);
  assert.equal(temporal.grade, 'temporal-proximity');
  assert.equal(temporal.confidence, 'weak');
  assert.ok(temporal.limitations.includes('temporal-not-causality'));
  assert.equal(included.suppressedTemporal, 0);
});

test('DC: no common ID means no causal pair; candidate window bounds temporal candidates', () => {
  const op = event({ eventId: 'ev-op', ids: { actionId: 'act-1' }, ts: { timelineMs: 100 } });
  const farVisual = visualEvent({ eventId: 'ev-vis', ts: { timelineMs: 5000 } });
  const sources = {
    operation: { events: [op], integrity: integrityComplete(), highWater: 1 },
    visual: { events: [farVisual], integrity: integrityComplete(), highWater: 1 },
    network: null,
  };
  const result = correlateDynamic({ dynamicSessionId: 'ds-1', sources, includeTemporal: true });
  assert.equal(result.pairs.some((pair) => pair.direction === 'operation->visual'), false);
  assert.equal(result.suppressedTemporal, 0);
});

test('DC: session mismatch and documentEpoch mismatch never merge; runGeneration blocks', () => {
  const op = event({
    eventId: 'ev-op', ids: { actionId: 'act-1', opId: 'op-1' },
    ts: { timelineMs: 100 }, documentEpoch: 'e1',
  });
  const visualSameOp = visualEvent({
    eventId: 'ev-vis', payload: { causeOpId: 'op-1' }, ts: { timelineMs: 150 }, documentEpoch: 'e2',
  });
  const result = correlateDynamic({
    dynamicSessionId: 'ds-1',
    sources: {
      operation: { events: [op], integrity: integrityComplete(), highWater: 1 },
      visual: { events: [visualSameOp], integrity: integrityComplete(), highWater: 1 },
      network: null,
    },
  });
  assert.equal(result.pairs.length, 0);
  assert.ok(result.unresolved.some((item) => item.reason === 'document-epoch-mismatch'));

  const otherSession = visualEvent({
    eventId: 'ev-other', dynamicSessionId: 'ds-2', payload: { causeOpId: 'op-1' }, ts: { timelineMs: 150 },
  });
  const sessionResult = correlateDynamic({
    dynamicSessionId: 'ds-1',
    sources: {
      operation: { events: [op], integrity: integrityComplete(), highWater: 1 },
      visual: { events: [otherSession], integrity: integrityComplete(), highWater: 1 },
      network: null,
    },
  });
  assert.ok(sessionResult.unresolved.some((item) => item.reason === 'session-mismatch'));

  const runMismatch = correlateDynamic({
    dynamicSessionId: 'ds-1',
    sources: {
      operation: { events: [{ ...op, runGeneration: 1 }], integrity: integrityComplete(), highWater: 1 },
      visual: { events: [{ ...visualSameOp, documentEpoch: 'e1', runGeneration: 2 }], integrity: integrityComplete(), highWater: 1 },
      network: null,
    },
  });
  assert.equal(runMismatch.pairs.length, 0);
  assert.ok(runMismatch.unresolved.some((item) => item.reason === 'run-generation-mismatch'));
});

test('DC: multiple same-rank candidates are all kept with ambiguous/unknown', () => {
  const op = event({
    eventId: 'ev-op',
    ids: { actionId: 'act-1', opId: 'op-1' },
    payload: { requestIds: ['t4-req-1'] },
    ts: { timelineMs: 100 },
  });
  const first = networkEvent({
    eventId: 'ev-n1', seq: 1, ts: { timelineMs: 120 },
    ids: { requestKey: requestKey('1') },
    payload: { appRequestId: 't4-req-1', headerVerified: true },
  });
  const second = networkEvent({
    eventId: 'ev-n2', seq: 2, ts: { timelineMs: 140 },
    ids: { requestKey: requestKey('2') },
    payload: { appRequestId: 't4-req-1', headerVerified: true },
  });
  const result = correlateDynamic({
    dynamicSessionId: 'ds-1',
    directions: ['operation->network'],
    sources: {
      operation: { events: [op], integrity: integrityComplete(), highWater: 1 },
      visual: null,
      network: { events: [first, second], integrity: integrityComplete(), highWater: 2 },
    },
  });
  assert.equal(result.pairs.length, 2);
  for (const pair of result.pairs) {
    assert.equal(pair.ambiguous, true);
    assert.equal(pair.confidence, 'unknown');
    assert.deepEqual([...pair.candidateIds].sort(), ['ev-n1', 'ev-n2']);
  }
  assert.ok(result.pairs.every((pair) => pair.basis === 'observed'));
});

test('DC: highWater locks late events; cursor paginates the same snapshot', () => {
  const op = event({ eventId: 'ev-op', ids: { actionId: 'act-1', opId: 'op-1' }, ts: { timelineMs: 100 } });
  const visualA = visualEvent({
    eventId: 'ev-va', payload: { causeOpId: 'op-1', causeVerified: true }, ts: { timelineMs: 120 },
  });
  const visualB = visualEvent({
    eventId: 'ev-vb', seq: 2, payload: { causeOpId: 'op-1' }, ts: { timelineMs: 125 },
  });
  const visualLate = visualEvent({
    eventId: 'ev-vlate', seq: 9, payload: { causeOpId: 'op-1' }, ts: { timelineMs: 130 },
  });
  const sources = {
    operation: { events: [op], integrity: integrityComplete(), highWater: 1 },
    visual: { events: [visualA, visualB, visualLate], integrity: integrityComplete(), highWater: 2 },
    network: null,
  };
  const result = correlateDynamic({ dynamicSessionId: 'ds-1', sources, limit: 1 });
  assert.equal(result.highWater.visual, 2);
  assert.ok(result.incomplete.includes('visual-late-events-ignored'));
  assert.equal(result.pairs.length, 1);
  assert.equal(result.cursor.next !== null, true);
  assert.equal(typeof result.cursor.next, 'string');

  const second = correlateDynamic({ dynamicSessionId: 'ds-1', sources, limit: 1, cursor: result.cursor.next });
  assert.equal(second.pairs.length, 1);
  assert.equal(typeof second.cursor.next, 'string');
  assert.notEqual(second.pairs[0].id, result.pairs[0].id);
  const third = correlateDynamic({ dynamicSessionId: 'ds-1', sources, limit: 1, cursor: second.cursor.next });
  assert.equal(third.pairs.length, 1);
  assert.equal(third.cursor.next, null);

  assert.throws(() => correlateDynamic({
    dynamicSessionId: 'ds-1', sources, limit: 1, cursor: result.cursor.next,
    window: { fromMs: 0, toMs: 50 },
  }), (error) => error.code === 'DYNAMIC_INVALID_ARGUMENT');
});

test('DC: cursor encode/decode is opaque and stable', () => {
  const descriptor = {
    dynamicSessionId: 'ds-1', scopeId: 's', offset: 2, fingerprint: 'abc', highWater: { operation: 1, visual: 2, network: null },
  };
  const cursor = encodeCorrelationCursor(descriptor);
  assert.equal(typeof cursor, 'string');
  assert.deepEqual(decodeCorrelationCursor(cursor), { v: 1, ...descriptor });
  assert.throws(() => decodeCorrelationCursor('not-a-cursor'), (error) => error.code === 'DYNAMIC_INVALID_ARGUMENT');
});

test('DC: uncollected sources are null in integrity with network-not-collected', () => {
  const result = correlateDynamic({
    dynamicSessionId: 'ds-1',
    sources: {
      operation: { events: [], integrity: integrityComplete(), highWater: 0 },
      visual: { events: [], integrity: integrityComplete(), highWater: 0 },
      network: null,
    },
  });
  assert.equal(result.integrity.network, null);
  assert.equal(result.integrity.complete, false);
  assert.ok(result.incomplete.includes('network-not-collected'));
  assert.equal(result.verdict.status, 'INCONCLUSIVE');
  assert.equal(result.verdict.reason, 'no-assertion');
  assert.equal(result.truncated, false);
});

test('DC: validateCorrelationInput enforces schema and direction enum', () => {
  assert.throws(() => validateCorrelationInput({}), (error) => error.code === 'DYNAMIC_INVALID_ARGUMENT');
  assert.throws(() => validateCorrelationInput({
    dynamicSessionId: 'd', directions: ['visual->visual', 'visual->visual'],
  }), (error) => error.code === 'DYNAMIC_INVALID_ARGUMENT');
  assert.throws(() => validateCorrelationInput({
    dynamicSessionId: 'd', directions: ['visual->operation'],
  }), (error) => error.code === 'DYNAMIC_INVALID_ARGUMENT');
  assert.throws(() => validateCorrelationInput({
    dynamicSessionId: 'd', beforeMs: 6000,
  }), (error) => error.code === 'DYNAMIC_INVALID_ARGUMENT');
  const normalized = validateCorrelationInput({ dynamicSessionId: 'd' });
  assert.deepEqual(normalized.directions, null);
  assert.equal(normalized.includeTemporal, false);
  assert.equal(normalized.beforeMs, 250);
  assert.equal(normalized.afterMs, 1000);
  assert.equal(normalized.limit, 50);
});

test('DC: mixed-grade chains take the weakest edge and never upgrade observed', () => {
  // op -> visual (explicit verified) + visual -> network (observed). Both pairs coexist, grades differ.
  const op = event({ eventId: 'ev-op', ids: { actionId: 'act-1', opId: 'op-1' }, ts: { timelineMs: 100 } });
  const visual = visualEvent({
    eventId: 'ev-vis', payload: { causeOpId: 'op-1', causeVerified: true }, ts: { timelineMs: 120 },
  });
  const network = networkEvent({
    eventId: 'ev-net', ts: { timelineMs: 140 }, payload: { causeEventId: 'ev-vis' },
  });
  const result = correlateDynamic({
    dynamicSessionId: 'ds-1',
    directions: ['operation->visual', 'visual->network'],
    sources: {
      operation: { events: [op], integrity: integrityComplete(), highWater: 1 },
      visual: { events: [visual], integrity: integrityComplete(), highWater: 1 },
      network: { events: [network], integrity: integrityComplete(), highWater: 1 },
    },
  });
  const explicit = result.pairs.find((pair) => pair.basis === 'explicit');
  const observed = result.pairs.find((pair) => pair.direction === 'visual->network');
  assert.equal(explicit.grade, 'confirmed-causal');
  assert.equal(observed.basis, 'observed');
  assert.equal(observed.grade, 'observed-association');
  assert.notEqual(observed.grade, 'confirmed-causal');
});

test('DC: normalizeDynamicEvent is reusable and rejects unknown fields', () => {
  const normalized = normalizeDynamicEvent({
    domain: 'visual', kind: 'frame', ts: { timelineMs: 5 }, ids: { frameId: 'fr-1' },
  }, { now: () => 1 });
  assert.equal(normalized.version, 1);
  assert.equal(normalized.ts.timelineMs, 5);
  assert.equal(normalized.provenance.trust, 'caller-declared');
  assert.throws(() => normalizeDynamicEvent({ domain: 'visual', kind: 'frame', nope: 1 }),
    (error) => error.code === 'DYNAMIC_INVALID_ARGUMENT');
});

/* ------------------------------------------------------------------ */
/* JPEG 解码（纯 JS baseline）与 bytes→image 物化                       */
/* ------------------------------------------------------------------ */

const FIXTURE_BYTES = {
  jpeg444: Buffer.from(FIXTURE_JPEG444.base64, 'base64'),
  jpeg422: Buffer.from(FIXTURE_JPEG422.base64, 'base64'),
  jpeg420: Buffer.from(FIXTURE_JPEG420.base64, 'base64'),
  jpegblack: Buffer.from(FIXTURE_JPEGBLACK.base64, 'base64'),
  jpegprog: Buffer.from(FIXTURE_JPEGPROG.base64, 'base64'),
};

function pixelAt(result, x, y) {
  const offset = (y * result.width + x) * 4;
  return [result.rgba[offset], result.rgba[offset + 1], result.rgba[offset + 2]];
}

function assertColor(actual, expected, tolerance, label) {
  for (let channel = 0; channel < 3; channel += 1) {
    const delta = Math.abs(actual[channel] - expected[channel]);
    assert.ok(delta <= tolerance, `${label} channel ${channel}: ${actual[channel]} vs ${expected[channel]} (Δ${delta} > ${tolerance})`);
  }
}

test('JPEG U-JPEG-CHROMIUM-RGB: embedded real baseline JPEG decodes 32x24 block colours', () => {
  assert.equal(FIXTURE_BYTES.jpeg444.length, FIXTURE_JPEG444.bytes);
  const result = decodeJpegRgba(FIXTURE_BYTES.jpeg444);
  assert.equal(result.ok, true);
  assert.equal(result.width, 32);
  assert.equal(result.height, 24);
  assert.ok(result.rgba instanceof Uint8ClampedArray);
  assert.equal(result.rgba.length, 32 * 24 * 4);
  assert.equal(result.decoder, 't4-jpeg-baseline-v1');
  assert.deepEqual(result.decoderProvenance, { kind: 'host-node-pure-js', version: 1 });
  // JPEG 有损：容差 ±2；三块纯色 + 顶点像素。
  assertColor(pixelAt(result, 0, 0), [220, 30, 40], 2, 'corner red');
  assertColor(pixelAt(result, 2, 2), [220, 30, 40], 2, 'red block');
  assertColor(pixelAt(result, 15, 12), [20, 180, 60], 2, 'green block');
  assertColor(pixelAt(result, 27, 12), [30, 60, 200], 2, 'blue block');
  assertColor(pixelAt(result, 31, 23), [30, 60, 200], 2, 'corner blue');
  assert.equal(result.rgba[3], 255);
});

test('JPEG: 4:2:2 and 4:2:0 subsampling decode with ±2 tolerance on interior pixels', () => {
  for (const name of ['jpeg422', 'jpeg420']) {
    const result = decodeJpegRgba(FIXTURE_BYTES[name]);
    assert.equal(result.ok, true, name);
    assert.equal(result.width, 32);
    assert.equal(result.height, 24);
    assertColor(pixelAt(result, 2, 2), [220, 30, 40], 2, `${name} red`);
    assertColor(pixelAt(result, 15, 12), [20, 180, 60], 2, `${name} green`);
    assertColor(pixelAt(result, 27, 12), [30, 60, 200], 2, `${name} blue`);
  }
});

test('JPEG: progressive and arithmetic are DECODER_UNSUPPORTED (no guessing, no throw)', () => {
  const progressive = decodeJpegRgba(FIXTURE_BYTES.jpegprog);
  assert.equal(progressive.ok, false);
  assert.equal(progressive.code, 'DECODER_UNSUPPORTED');

  const arithmeticBytes = Buffer.from(FIXTURE_BYTES.jpeg444);
  for (let index = 0; index + 1 < arithmeticBytes.length; index += 1) {
    if (arithmeticBytes[index] === 0xFF && arithmeticBytes[index + 1] === 0xC0) {
      arithmeticBytes[index + 1] = 0xC9; // SOF9 = arithmetic sequential
      break;
    }
  }
  const arithmetic = decodeJpegRgba(arithmeticBytes);
  assert.equal(arithmetic.ok, false);
  assert.equal(arithmetic.code, 'DECODER_UNSUPPORTED');

  const truncated = decodeJpegRgba(FIXTURE_BYTES.jpeg444.subarray(0, 120));
  assert.equal(truncated.ok, false);
  assert.ok(truncated.code.startsWith('DECODER_'));
  assert.equal(decodeJpegRgba(new Uint8Array([1, 2, 3])).code, 'DECODER_INVALID');
});

test('JPEG: decodeFrameRgba dispatches PNG through vision-t3 and keeps encoded/rgba hashes separate', async () => {
  const { encodePngRgba } = await import('../vision-t3.js');
  const png = encodePngRgba(fillImage(4, 3, RED));
  const decoded = decodeFrameRgba({ encoding: 'png', bytes: png });
  assert.equal(decoded.ok, true);
  assert.equal(decoded.width, 4);
  assert.equal(decoded.height, 3);
  assert.equal(decoded.decoder, 't3-png');

  const store = new DynamicFrameStore({ scopeId: 'scope-1', dynamicSessionId: 'ds-1', now: () => 1 });
  const encodedHash = FIXTURE_JPEG444.sha256;
  const added = store.addFrame({
    frameId: 'jpeg-1',
    sourceTimestamp: null,
    receivedMonoMs: 1000,
    timelineMs: 100,
    encoding: 'jpeg',
    bytes: Buffer.from(FIXTURE_JPEG444.base64, 'base64'),
    dimensions: { width: 32, height: 24 },
  });
  assert.equal(added.ok, true);
  const record = store.getFrame('jpeg-1');
  assert.equal(record.sourceTimestamp, null);
  assert.equal(record.encodedSha256, encodedHash);
  assert.equal(record.sha256, encodedHash);
  assert.equal(record.rgbaSha256, null);
  assert.equal(store.getFrameImage('jpeg-1'), null);

  const materialized = materializeFrameImage(record);
  assert.equal(materialized.ok, true);
  assert.equal(materialized.image.width, 32);
  assert.equal(materialized.image.height, 24);
  assert.equal(materialized.decoder, 't4-jpeg-baseline-v1');
  const meta = frameMeta(record);
  assert.equal(meta.bytes, FIXTURE_BYTES.jpeg444.length);
  assert.equal(meta.encodedSha256, encodedHash);
  assert.equal(meta.rgbaSha256, null);
  const serialized = JSON.stringify(meta);
  assert.equal(serialized.includes('Buffer'), false);
  assert.equal(/"rgba"\s*:/.test(serialized), false);
});

test('runMotionAssertions: store frames with only JPEG bytes are materialized on demand', () => {
  const store = new DynamicFrameStore({ scopeId: 'scope-1', dynamicSessionId: 'ds-1', now: () => 1 });
  const add = (frameId, base64, sha, timelineMs) => store.addFrame({
    frameId,
    sourceTimestamp: null,
    receivedMonoMs: 1000 + timelineMs,
    timelineMs,
    encoding: 'jpeg',
    bytes: Buffer.from(base64, 'base64'),
    dimensions: { width: 32, height: 24 },
  });
  add('j1', FIXTURE_JPEG444.base64, FIXTURE_JPEG444.sha256, 0);
  add('j2', FIXTURE_JPEGBLACK.base64, FIXTURE_JPEGBLACK.sha256, 100);
  const frames = store.getFrames({ limit: 10 });
  const changed = runMotionAssertions({ frames, assertions: [{ id: 'diff', type: 'frame-diff' }] });
  assert.equal(changed.verdict, 'FAIL');
  assert.equal(changed.exitCode, 1);
  assert.equal(changed.results[0].encoding, 'jpeg');
  assert.equal(changed.results[0].precise, false);
  assert.ok(changed.results[0].limitations.includes('jpeg-compression-noise'));

  // 同一 JPEG 两帧 → 无变化 PASS（仍标 jpeg/precise=false）
  const sameStore = new DynamicFrameStore({ scopeId: 'scope-1', dynamicSessionId: 'ds-1', now: () => 1 });
  sameStore.addFrame({ frameId: 'k1', receivedMonoMs: 1000, timelineMs: 0, encoding: 'jpeg', bytes: Buffer.from(FIXTURE_JPEG444.base64, 'base64'), dimensions: { width: 32, height: 24 } });
  sameStore.addFrame({ frameId: 'k2', receivedMonoMs: 1040, timelineMs: 40, encoding: 'jpeg', bytes: Buffer.from(FIXTURE_JPEG444.base64, 'base64'), dimensions: { width: 32, height: 24 } });
  const unchanged = runMotionAssertions({ frames: sameStore.getFrames({ limit: 10 }), assertions: [{ id: 'diff', type: 'frame-diff' }] });
  assert.equal(unchanged.verdict, 'PASS');
  assert.equal(unchanged.results[0].encoding, 'jpeg');
  assert.equal(unchanged.results[0].precise, false);
});

test('runMotionAssertions: jank-only never needs pixel decoding (bytes-only frames)', () => {
  const store = new DynamicFrameStore({ scopeId: 'scope-1', dynamicSessionId: 'ds-1', now: () => 1 });
  for (let index = 0; index < 3; index += 1) {
    store.addFrame({
      frameId: `jank-${index}`,
      receivedMonoMs: 1000 + index * 40,
      timelineMs: index * 40,
      encoding: 'jpeg',
      bytes: Buffer.from(FIXTURE_JPEG444.base64, 'base64'),
      dimensions: { width: 32, height: 24 },
    });
  }
  const result = runMotionAssertions({
    frames: store.getFrames({ limit: 10 }),
    assertions: [{ id: 'jank', type: 'jank', expectedIntervalMs: 40 }],
  });
  assert.equal(result.results[0].verdict, 'PASS');
  assert.ok(result.results[0].reasons.includes('no-jank'));
});

test('runMotionAssertionsAsync: yields between assertions and flags scheduling', async () => {
  const result = await runMotionAssertionsAsync({
    frames: solid(BLACK, WHITE),
    assertions: [{ id: 'diff', type: 'frame-diff' }],
  });
  assert.equal(result.scheduling, 'between-assertions');
  assert.equal(result.verdict, 'FAIL');
  const sync = runMotionAssertions({
    frames: solid(BLACK, WHITE),
    assertions: [{ id: 'diff', type: 'frame-diff' }],
  });
  assert.equal(sync.scheduling, 'synchronous');
});

test('runMotionAssertions: cumulative budget timeout returns BLOCKED results (DYNAMIC_TIMEOUT semantics)', () => {
  const originalNow = Date.now;
  let ticks = 0;
  Date.now = () => 1_000_000 + (ticks++ * 1000);
  try {
    const result = runMotionAssertions({
      frames: solid(BLACK, WHITE),
      assertions: [
        { id: 'a', type: 'frame-diff' },
        { id: 'b', type: 'region-change' },
      ],
      limits: { algorithmBudgetMs: 1 },
    });
    assert.equal(result.timedOut, true);
    assert.equal(result.verdict, 'BLOCKED');
    assert.equal(result.exitCode, 2);
    assert.equal(result.results.length, 2);
    assert.ok(result.results.every((item) => item.verdict === 'BLOCKED'));
    assert.ok(result.results.every((item) => item.reasons.includes('dynamic-timeout')));
  } finally {
    Date.now = originalNow;
  }
});

test('runMotionAssertions: aborted signal fails fast with ABORTED', () => {
  const controller = new AbortController();
  controller.abort();
  const error = catchError(() => runMotionAssertions({
    frames: solid(BLACK, WHITE),
    assertions: [{ id: 'a', type: 'frame-diff' }],
    signal: controller.signal,
  }));
  assert.equal(error.code, 'ABORTED');
});

test('DC: network→visual explicit requires verified ui cause; operation→network explicit requires header bridge', () => {
  const network = networkEvent({
    eventId: 'ev-net', seq: 1, ts: { timelineMs: 100 },
    ids: { requestKey: requestKey('500.1') },
    payload: { status: 500 },
  });
  const visual = visualEvent({
    eventId: 'ev-banner', ts: { timelineMs: 140 },
    payload: {
      cause: { kind: 'network', eventId: 'ev-net' },
      causeVerified: true,
      uiTransition: true,
    },
  });
  const op = event({
    eventId: 'ev-op', ids: { actionId: 'act-9', opId: 'op-9' }, ts: { timelineMs: 90 },
    payload: { requestIds: ['t4-req-9'] },
  });
  const net2 = networkEvent({
    eventId: 'ev-net2', seq: 2, ts: { timelineMs: 110 },
    ids: { requestKey: requestKey('500.2') },
    payload: { appRequestId: 't4-req-9', headerVerified: true },
  });
  const result = correlateDynamic({
    dynamicSessionId: 'ds-1',
    directions: ['network->visual', 'operation->network'],
    sources: {
      operation: { events: [op], integrity: integrityComplete(), highWater: 1 },
      visual: { events: [visual], integrity: integrityComplete(), highWater: 1 },
      network: { events: [network, net2], integrity: integrityComplete(), highWater: 2 },
    },
  });
  const ui = result.pairs.find((pair) => pair.direction === 'network->visual');
  assert.equal(ui.basis, 'explicit');
  assert.equal(ui.grade, 'confirmed-causal');
  assert.equal(ui.confidence, 'direct');
  const request = result.pairs.find((pair) => pair.direction === 'operation->network');
  assert.equal(request.basis, 'explicit');
  assert.equal(request.grade, 'confirmed-causal');
  assert.equal(request.fromEventId, 'ev-op');
  assert.equal(request.toEventId, 'ev-net2');
});

test('DC: visual→visual shared op/clock is observed; only verified parent is explicit', () => {
  const first = visualEvent({ eventId: 'ev-v1', seq: 1, ts: { timelineMs: 100 }, ids: { opId: 'op-7' }, payload: { clockId: 'clock-1' } });
  const second = visualEvent({ eventId: 'ev-v2', seq: 2, ts: { timelineMs: 140 }, ids: { opId: 'op-7' }, payload: { clockId: 'clock-1' } });
  const verifiedParent = visualEvent({
    eventId: 'ev-v3', seq: 3, ts: { timelineMs: 180 },
    payload: { parentEventId: 'ev-v1', parentVerified: true },
  });
  const declaredParent = visualEvent({
    eventId: 'ev-v4', seq: 4, ts: { timelineMs: 220 },
    payload: { parentEventId: 'ev-v1' },
  });
  const result = correlateDynamic({
    dynamicSessionId: 'ds-1',
    directions: ['visual->visual'],
    sources: {
      operation: null,
      visual: { events: [first, second, verifiedParent, declaredParent], integrity: integrityComplete(), highWater: 4 },
      network: null,
    },
  });
  const shared = result.pairs.find((pair) => pair.fromEventId === 'ev-v1' && pair.toEventId === 'ev-v2');
  assert.equal(shared.basis, 'observed');
  assert.equal(shared.grade, 'observed-association');
  assert.ok(shared.limitations.includes('shared-op-not-causality'));
  const explicit = result.pairs.find((pair) => pair.fromEventId === 'ev-v1' && pair.toEventId === 'ev-v3');
  assert.equal(explicit.basis, 'explicit');
  assert.equal(explicit.grade, 'confirmed-causal');
  assert.equal(result.pairs.some((pair) => pair.toEventId === 'ev-v4' && pair.basis === 'explicit'), false);
  assert.ok(result.unresolved.some((item) => item.eventId === 'ev-v4' && item.reason === 'declared-link-unverified'));
});

test('DC: missing cause/parent endpoints stay unresolved instead of invented edges', () => {
  const visual = visualEvent({
    eventId: 'ev-orphan', seq: 1, ts: { timelineMs: 100 },
    payload: { cause: { kind: 'network', eventId: 'ev-missing-net' } },
  });
  const network = networkEvent({
    eventId: 'ev-net', seq: 1, ts: { timelineMs: 140 },
    payload: { causeEventId: 'ev-missing-visual' },
  });
  const result = correlateDynamic({
    dynamicSessionId: 'ds-1',
    directions: ['network->visual', 'visual->network'],
    sources: {
      operation: null,
      visual: { events: [visual], integrity: integrityComplete(), highWater: 1 },
      network: { events: [network], integrity: integrityComplete(), highWater: 1 },
    },
  });
  assert.ok(result.unresolved.some((item) => item.eventId === 'ev-orphan' && item.reason === 'network-cause-missing'));
  assert.ok(result.unresolved.some((item) => item.eventId === 'ev-net' && item.reason === 'visual-cause-missing'));
  assert.equal(result.pairs.length, 0);
});

test('DC: HMAC/trace namespaces and RequestKey hops are not joined across sessions', () => {
  const first = networkEvent({
    eventId: 'ev-x1', seq: 1, ts: { timelineMs: 100 },
    ids: { requestKey: requestKey('1', { networkSessionId: 'ns-A', targetId: 'T1', hopId: 0 }), traceIdHash: 'trace-same' },
  });
  const otherSession = networkEvent({
    eventId: 'ev-x2', seq: 2, ts: { timelineMs: 140 },
    ids: { requestKey: requestKey('1', { networkSessionId: 'ns-B', targetId: 'T1', hopId: 0 }), traceIdHash: 'trace-same' },
  });
  const otherTarget = networkEvent({
    eventId: 'ev-x3', seq: 3, ts: { timelineMs: 180 },
    ids: { requestKey: requestKey('1', { networkSessionId: 'ns-A', targetId: 'T2', hopId: 0 }), traceIdHash: 'trace-other' },
  });
  const otherHop = networkEvent({
    eventId: 'ev-x4', seq: 4, ts: { timelineMs: 220 },
    ids: { requestKey: requestKey('1', { networkSessionId: 'ns-A', targetId: 'T1', hopId: 1 }), traceIdHash: 'trace-third' },
  });
  const result = correlateDynamic({
    dynamicSessionId: 'ds-1',
    directions: ['network->network'],
    sources: {
      operation: null, visual: null,
      network: { events: [first, otherSession, otherTarget, otherHop], integrity: integrityComplete(), highWater: 4 },
    },
  });
  assert.equal(result.pairs.length, 0);
});

test('DC: unverified network→visual cause is observed with page-declared limitation', () => {
  const network = networkEvent({ eventId: 'ev-n', seq: 1, ts: { timelineMs: 100 }, ids: { requestKey: requestKey('9') } });
  const visual = visualEvent({
    eventId: 'ev-v', seq: 1, ts: { timelineMs: 140 },
    payload: { cause: { kind: 'network', eventId: 'ev-n' } },
  });
  const result = correlateDynamic({
    dynamicSessionId: 'ds-1',
    directions: ['network->visual'],
    sources: {
      operation: null,
      visual: { events: [visual], integrity: integrityComplete(), highWater: 1 },
      network: { events: [network], integrity: integrityComplete(), highWater: 1 },
    },
  });
  const pair = result.pairs.find((item) => item.direction === 'network->visual');
  assert.equal(pair.basis, 'observed');
  assert.equal(pair.grade, 'observed-association');
  assert.ok(pair.limitations.includes('page-declared-cause'));
});

test('JPEG U-JPEG-CHROMIUM-RGB: real Chromium canvas JPEG decodes with ±2 block colours', () => {
  const bytes = Buffer.from(FIXTURE_CHROMIUM_CANVAS.base64, 'base64');
  assert.equal(bytes.length, FIXTURE_CHROMIUM_CANVAS.bytes);
  assert.equal(bytes.length, 888);
  assert.equal(
    createHash('sha256').update(bytes).digest('hex'),
    FIXTURE_CHROMIUM_CANVAS.sha256,
  );
  const result = decodeJpegRgba(bytes);
  assert.equal(result.ok, true);
  assert.equal(result.width, 32);
  assert.equal(result.height, 24);
  assert.equal(result.decoder, 't4-jpeg-baseline-v1');
  assert.deepEqual(result.decoderProvenance, { kind: 'host-node-pure-js', version: 1 });
  assertColor(pixelAt(result, 5, 12), [220, 30, 40], 2, 'chromium red block');
  assertColor(pixelAt(result, 15, 12), [20, 180, 60], 2, 'chromium green block');
  assertColor(pixelAt(result, 26, 12), [30, 60, 200], 2, 'chromium blue block');
  assertColor(pixelAt(result, 0, 0), [220, 30, 40], 2, 'chromium corner red');
  assertColor(pixelAt(result, 31, 23), [30, 60, 200], 2, 'chromium corner blue');
});

test('DC: candidate comparison budget truncates instead of unbounded join', () => {
  const ops = [];
  const visuals = [];
  for (let index = 0; index < 220; index += 1) {
    ops.push(event({ eventId: `op-${index}`, ids: { actionId: `act-${index}` }, ts: { timelineMs: index } }));
    visuals.push(visualEvent({ eventId: `vis-${index}`, ts: { timelineMs: 1000 + index } }));
  }
  const result = correlateDynamic({
    dynamicSessionId: 'ds-1',
    directions: ['operation->visual'],
    sources: {
      operation: { events: ops, integrity: integrityComplete(), highWater: 220 },
      visual: { events: visuals, integrity: integrityComplete(), highWater: 220 },
      network: null,
    },
  });
  assert.equal(result.truncated, true);
  assert.ok(result.incomplete.includes('candidate-budget-exhausted'));
  assert.equal(result.integrity.complete, false);
  assert.equal(result.diagnostics.maxCandidateCompares, 40000);
  assert.ok(result.diagnostics.estimatedPairComparisons > 20000);
});

test('chromium-canvas-jpeg-32x24: Lead fixture sha/dimensions/5 pixels and encoded≠rgba hash', () => {
  const bytes = Buffer.from(FIXTURE_CHROMIUM_LEAD.base64, 'base64');
  assert.equal(bytes.length, 898);
  assert.equal(bytes.length, FIXTURE_CHROMIUM_LEAD.bytes);
  const encodedSha256 = createHash('sha256').update(bytes).digest('hex');
  assert.equal(encodedSha256, '81120abbe03a0f672cfa49968f1fe5cab2be75062992a989330712a264781766');
  assert.equal(encodedSha256, FIXTURE_CHROMIUM_LEAD.sha256);

  const result = decodeJpegRgba(bytes);
  assert.equal(result.ok, true);
  assert.equal(result.width, 32);
  assert.equal(result.height, 24);
  assert.equal(result.decoder, 't4-jpeg-baseline-v1');

  // Lead 独立实测的 5 个抽样点（设计值见括号），JPEG 有损容差 ±2。
  assertColor(pixelAt(result, 0, 0), [220, 30, 40], 2, 'p(0,0)');
  assertColor(pixelAt(result, 2, 2), [220, 31, 38], 2, 'p(2,2)');
  assertColor(pixelAt(result, 15, 12), [18, 180, 61], 2, 'p(15,12)');
  assertColor(pixelAt(result, 27, 12), [31, 60, 198], 2, 'p(27,12)');
  assertColor(pixelAt(result, 31, 23), [29, 61, 198], 2, 'p(31,23)');

  const rgbaSha256 = createHash('sha256')
    .update(Buffer.from(result.rgba.buffer, result.rgba.byteOffset, result.rgba.byteLength))
    .digest('hex');
  assert.notEqual(encodedSha256, rgbaSha256);
  assert.equal(rgbaSha256.length, 64);
});

/* ------------------------------------------------------------------ */
/* DC 候选预筛（Lead 2026-11-04 裁决）：同域窗口先筛再计预算            */
/* ------------------------------------------------------------------ */

function visualTimeline(count, stepMs) {
  return Array.from({ length: count }, (_, index) => visualEvent({
    eventId: `vp-${index}`,
    seq: index + 1,
    ts: { timelineMs: index * stepMs },
  }));
}

function sameDomainFixture(events) {
  return {
    operation: null,
    visual: { events, integrity: integrityComplete(), highWater: events.length },
    network: null,
  };
}

test('DC prefilter: 180 frames @40ms visual->visual stays under budget with no truncation', () => {
  const events = visualTimeline(180, 40);
  const result = correlateDynamic({
    dynamicSessionId: 'ds-1',
    directions: ['visual->visual'],
    sources: sameDomainFixture(events),
  });
  assert.equal(result.truncated, false);
  assert.equal(result.diagnostics.maxCandidateCompares, 40000);
  // 对称窗口 ±1250ms、40ms 间隔 → 每帧前后各 31 帧：2*Σ(180-d), d=1..31 = 10168。
  assert.equal(result.diagnostics.estimatedPairComparisons, 10168);
  assert.equal(result.diagnostics.directionComparisons['visual->visual'], 10168);
  assert.equal(result.diagnostics.sameDomainPrefilter.windowMs, 1250);
  assert.deepEqual(result.diagnostics.sameDomainPrefilter.applied, ['visual->visual']);
  // 全量 O(n²) 上界 180*179=32220，预筛跳过 22052。
  assert.equal(result.diagnostics.upperBoundPairComparisons, 32220);
  assert.equal(result.diagnostics.sameDomainPrefilter.skippedPairComparisons, 22052);
  assert.equal(result.pairs.length, 0);
  assert.equal(result.suppressedTemporal, 10168);
});

test('DC prefilter: 180 frames @17ms stays under 40000 with no truncation', () => {
  const events = visualTimeline(180, 17);
  const result = correlateDynamic({
    dynamicSessionId: 'ds-1',
    directions: ['visual->visual'],
    sources: sameDomainFixture(events),
  });
  assert.equal(result.truncated, false);
  assert.equal(result.diagnostics.candidateBudgetExhausted, false);
  assert.equal(result.diagnostics.estimatedPairComparisons, 20878);
  assert.equal(result.suppressedTemporal, 20878);
  assert.equal(result.diagnostics.maxCandidateCompares, 40000);
});

test('DC prefilter: 300 frames @17ms stays under 40000; dense 10ms hits the cap honestly', () => {
  const sparse = correlateDynamic({
    dynamicSessionId: 'ds-1',
    directions: ['visual->visual'],
    sources: sameDomainFixture(visualTimeline(300, 17)),
  });
  assert.equal(sparse.truncated, false);
  assert.equal(sparse.diagnostics.estimatedPairComparisons, 38398);
  assert.equal(sparse.suppressedTemporal, 38398);

  const dense = correlateDynamic({
    dynamicSessionId: 'ds-1',
    directions: ['visual->visual'],
    sources: sameDomainFixture(visualTimeline(300, 10)),
  });
  assert.equal(dense.truncated, true);
  assert.equal(dense.diagnostics.candidateBudgetExhausted, true);
  assert.ok(dense.incomplete.includes('candidate-budget-exhausted'));
  assert.equal(dense.diagnostics.estimatedPairComparisons, 40001);
  assert.equal(dense.suppressedTemporal, 40000);
});

test('DC prefilter: suppressedTemporal and pairs never double-count the same endpoints', () => {
  const first = visualEvent({ eventId: 'same-1', seq: 1, ts: { timelineMs: 0 }, ids: { opId: 'op-shared' } });
  const second = visualEvent({ eventId: 'same-2', seq: 2, ts: { timelineMs: 100 }, ids: { opId: 'op-shared' } });
  const sources = {
    operation: null,
    visual: { events: [first, second], integrity: integrityComplete(), highWater: 2 },
    network: null,
  };
  const included = correlateDynamic({
    dynamicSessionId: 'ds-1', directions: ['visual->visual'], sources, includeTemporal: true,
  });
  assert.equal(included.pairs.length, 1);
  assert.equal(included.pairs[0].basis, 'observed');
  assert.equal(included.suppressedTemporal, 0);
  const filtered = correlateDynamic({
    dynamicSessionId: 'ds-1', directions: ['visual->visual'], sources, includeTemporal: false,
  });
  assert.equal(filtered.pairs.length, 1);
  assert.equal(filtered.suppressedTemporal, 0);
  assert.equal(filtered.diagnostics.suppressedTemporal, 0);
});

test('DC prefilter: boundary |Δt| == beforeMs+afterMs is included, one ms beyond is not', () => {
  const edge = correlateDynamic({
    dynamicSessionId: 'ds-1',
    directions: ['visual->visual'],
    includeTemporal: true,
    sources: sameDomainFixture([
      visualEvent({ eventId: 'edge-a', seq: 1, ts: { timelineMs: 0 } }),
      visualEvent({ eventId: 'edge-b', seq: 2, ts: { timelineMs: 1250 } }),
    ]),
  });
  // 同域邻近方向是无向的：两帧各作为 from 计一次比较/一条 temporal pair。
  assert.equal(edge.diagnostics.estimatedPairComparisons, 2);
  assert.equal(edge.pairs.length, 2);
  assert.ok(edge.pairs.every((pair) => pair.basis === 'temporal'));
  assert.deepEqual(edge.pairs.map((pair) => `${pair.fromEventId}->${pair.toEventId}`).sort(), ['edge-a->edge-b', 'edge-b->edge-a']);
  assert.equal(edge.suppressedTemporal, 0);

  const beyond = correlateDynamic({
    dynamicSessionId: 'ds-1',
    directions: ['visual->visual'],
    includeTemporal: true,
    sources: sameDomainFixture([
      visualEvent({ eventId: 'edge-c', seq: 1, ts: { timelineMs: 0 } }),
      visualEvent({ eventId: 'edge-d', seq: 2, ts: { timelineMs: 1251 } }),
    ]),
  });
  assert.equal(beyond.diagnostics.estimatedPairComparisons, 0);
  assert.equal(beyond.pairs.length, 0);
});

test('DC prefilter: cross-domain candidate counts are not reduced by same-domain prefilter', () => {
  const ops = Array.from({ length: 20 }, (_, index) => event({
    eventId: `xop-${index}`, seq: index + 1, ids: { actionId: `xact-${index}` }, ts: { timelineMs: index * 10 },
  }));
  const visuals = Array.from({ length: 20 }, (_, index) => visualEvent({
    eventId: `xvis-${index}`, seq: index + 1, ts: { timelineMs: index * 10 },
  }));
  const result = correlateDynamic({
    dynamicSessionId: 'ds-1',
    directions: ['operation->visual'],
    sources: {
      operation: { events: ops, integrity: integrityComplete(), highWater: 20 },
      visual: { events: visuals, integrity: integrityComplete(), highWater: 20 },
      network: null,
    },
  });
  // 跨域保持完整枚举：20*20=400，不因同域预筛减少。
  assert.equal(result.diagnostics.directionComparisons['operation->visual'], 400);
  assert.equal(result.diagnostics.estimatedPairComparisons, 400);
  assert.deepEqual(result.diagnostics.sameDomainPrefilter.applied, []);
  assert.equal(result.diagnostics.sameDomainPrefilter.skippedPairComparisons, 0);
});

test('session duration: hard 60000 accepted, >60000 rejected, budgets do not scale with duration', () => {
  assert.equal(validateSessionDuration(undefined), 3000);
  assert.equal(validateSessionDuration(60000), 60000);
  assert.equal(validateSessionDuration(1), 1);
  assert.throws(() => validateSessionDuration(60001), (error) => error.code === 'DYNAMIC_INVALID_ARGUMENT');
  assert.throws(() => validateSessionDuration(0), (error) => error.code === 'DYNAMIC_INVALID_ARGUMENT');
  assert.throws(() => validateSessionDuration(3000.5), (error) => error.code === 'DYNAMIC_INVALID_ARGUMENT');
  assert.throws(() => validateSessionDuration('60000'), (error) => error.code === 'DYNAMIC_INVALID_ARGUMENT');

  // 会话时长放宽不放大任何资源预算，也不改变重校准/阈值时间边界。
  assert.equal(T4_LIMITS.maxFrames, 180);
  assert.equal(T4_LIMITS.maxFramesHard, 300);
  assert.equal(T4_LIMITS.maxBytes, 33554432);
  assert.equal(T4_LIMITS.maxBytesHard, 67108864);
  assert.equal(T4_LIMITS.maxEvents, 5000);
  assert.equal(T4_LIMITS.maxEventsHard, 20000);
  assert.equal(T4_LIMITS.algorithmBudgetMs, 5000);
  assert.equal(T4_LIMITS.maxCandidateCompares, 40000);
  assert.equal(T4_LIMITS.recalibrateAfterMs, 10000);
  assert.equal(T4_LIMITS.maxClockUncertaintyMs, 10);
  // 允许最大时长后，常量表本身不变（无隐式线性放大）。
  assert.equal(validateSessionDuration(60000), 60000);
  assert.equal(T4_LIMITS.maxFrames, 180);
  assert.equal(T4_LIMITS.algorithmBudgetMs, 5000);
});

test('session extend: deadline math and cumulative growth', () => {
  const first = validateSessionExtend({ durationMs: 5000, startedAt: 0, deadlineMs: 3000, nowMonoMs: 1000 });
  assert.deepEqual(first, {
    ok: true, extendMs: 5000, previousDeadlineMs: 3000, newDeadlineMs: 8000, cumulativeMs: 8000,
  });
  const second = validateSessionExtend({ durationMs: 60000, startedAt: 0, deadlineMs: first.newDeadlineMs, nowMonoMs: 7000 });
  assert.deepEqual(second, {
    ok: true, extendMs: 60000, previousDeadlineMs: 8000, newDeadlineMs: 68000, cumulativeMs: 68000,
  });
  assert.ok(second.cumulativeMs > first.cumulativeMs);
  // 稳健性：deadline 已过（在 start/stop 竞态或时钟抖动时不应出现），从 now 起算。
  const late = validateSessionExtend({ durationMs: 2000, startedAt: 0, deadlineMs: 1000, nowMonoMs: 5000 });
  assert.equal(late.previousDeadlineMs, 1000);
  assert.equal(late.newDeadlineMs, 7000);
  assert.equal(late.cumulativeMs, 7000);
});

test('session extend: single extend bounds and invalid inputs are rejected without throwing', () => {
  const tooLong = validateSessionExtend({ durationMs: 60001, startedAt: 0, deadlineMs: 3000, nowMonoMs: 1000 });
  assert.equal(tooLong.ok, false);
  assert.equal(tooLong.code, 'DYNAMIC_INVALID_ARGUMENT');
  assert.equal(tooLong.field, 'durationMs');
  assert.equal(tooLong.limit, 'maxSessionExtendMs');
  assert.equal(tooLong.actual, 60001);
  assert.equal(tooLong.max, 60000);

  for (const value of [0, -1, -60000, 1.5, '1000', Number.NaN, undefined]) {
    const result = validateSessionExtend({ durationMs: value, startedAt: 0, deadlineMs: 3000, nowMonoMs: 1000 });
    assert.equal(result.ok, false, `durationMs=${String(value)}`);
    assert.equal(result.code, 'DYNAMIC_INVALID_ARGUMENT', `durationMs=${String(value)}`);
    assert.equal(result.field, 'durationMs', `durationMs=${String(value)}`);
  }
  const badStartedAt = validateSessionExtend({ durationMs: 1, startedAt: '0', deadlineMs: 0, nowMonoMs: 0 });
  assert.equal(badStartedAt.code, 'DYNAMIC_INVALID_ARGUMENT');
  assert.equal(badStartedAt.field, 'startedAt');
  const unknown = validateSessionExtend({ durationMs: 1, startedAt: 0, deadlineMs: 0, nowMonoMs: 0, nope: 1 });
  assert.equal(unknown.code, 'DYNAMIC_INVALID_ARGUMENT');
  assert.equal(unknown.field, 'nope');
  const notObject = validateSessionExtend('x');
  assert.equal(notObject.code, 'DYNAMIC_INVALID_ARGUMENT');
});

test('session extend: cumulative cap boundary and multi-extend accumulation', () => {
  // 恰好 300000 通过
  const exact = validateSessionExtend({ durationMs: 60000, startedAt: 0, deadlineMs: 240000, nowMonoMs: 240000 });
  assert.equal(exact.ok, true);
  assert.equal(exact.newDeadlineMs, 300000);
  assert.equal(exact.cumulativeMs, 300000);
  // 超出 1ms 被累计上限拒绝
  const overCap = validateSessionExtend({ durationMs: 60000, startedAt: 0, deadlineMs: 240001, nowMonoMs: 240001 });
  assert.equal(overCap.ok, false);
  assert.equal(overCap.code, 'DYNAMIC_LIMIT_EXCEEDED');
  assert.equal(overCap.field, 'cumulativeMs');
  assert.equal(overCap.limit, 'sessionCapMs');
  assert.equal(overCap.actual, 300001);
  assert.equal(overCap.max, 300000);
  // 恰好 60000 单次通过
  const maxExtend = validateSessionExtend({ durationMs: 60000, startedAt: 0, deadlineMs: 1000, nowMonoMs: 1000 });
  assert.equal(maxExtend.ok, true);
  assert.equal(maxExtend.extendMs, 60000);
  // 多次续约累加：63000 → 123000 → 183000 → 243000 → 303000（拒绝）
  let deadlineMs = 3000;
  const cumulative = [];
  let rejection = null;
  for (let index = 0; index < 6; index += 1) {
    const nowMonoMs = Math.max(0, deadlineMs - 1000);
    const result = validateSessionExtend({ durationMs: 60000, startedAt: 0, deadlineMs, nowMonoMs });
    if (!result.ok) {
      rejection = result;
      break;
    }
    cumulative.push(result.cumulativeMs);
    deadlineMs = result.newDeadlineMs;
  }
  assert.deepEqual(cumulative, [63000, 123000, 183000, 243000]);
  assert.equal(rejection.code, 'DYNAMIC_LIMIT_EXCEEDED');
  assert.equal(rejection.actual, 303000);
  assert.equal(rejection.max, 300000);
});

/* ------------------------------------------------------------------ */
/* crop-on-delivery：cropFrameRoi                                       */
/* ------------------------------------------------------------------ */

function rgbaHashOf(image) {
  return createHash('sha256')
    .update(Buffer.from(image.rgba.buffer, image.rgba.byteOffset, image.rgba.byteLength))
    .digest('hex');
}

test('cropFrameRoi: normal ROI crop keeps pixels, exact size, ROI hash over cropped RGBA', () => {
  const full = fillImage(100, 80, BLACK, [{ x: 20, y: 10, width: 30, height: 20, color: RED }]);
  const frame = { frameId: 'synthetic', image: full, encoding: 'png' };
  const result = cropFrameRoi(frame, { x: 20, y: 10, width: 30, height: 20 });
  assert.equal(result.ok, true);
  assert.equal(result.image.width, 30);
  assert.equal(result.image.height, 20);
  assert.equal(result.image.rgba.length, 30 * 20 * 4);
  assert.deepEqual([...result.image.rgba.subarray(0, 4)], [255, 0, 0, 255]);
  assert.deepEqual(result.region, { x: 20, y: 10, width: 30, height: 20 });
  assert.equal(result.source.width, 100);
  assert.equal(result.source.height, 80);
  assert.equal(result.source.encoding, 'png');
  assert.equal(result.source.sha256, null); // 纯图像帧没有编码 hash，不伪造
  assert.equal(result.roiSha256, rgbaHashOf(result.image));
  assert.equal(result.roiSha256.length, 64);

  const other = cropFrameRoi(frame, { x: 0, y: 0, width: 10, height: 10 });
  assert.equal(other.ok, true);
  assert.notEqual(other.roiSha256, result.roiSha256);
});

test('cropFrameRoi: full frame and edge-touching ROI are allowed, no clamp', () => {
  const full = fillImage(40, 30, GREEN);
  const whole = cropFrameRoi({ image: full }, { x: 0, y: 0, width: 40, height: 30 });
  assert.equal(whole.ok, true);
  assert.equal(whole.image.width, 40);
  assert.equal(whole.image.height, 30);
  const edge = cropFrameRoi({ image: full }, { x: 30, y: 20, width: 10, height: 10 });
  assert.equal(edge.ok, true);
  assert.equal(edge.image.width, 10);
  assert.equal(edge.image.height, 10);
  const bottomRight = cropFrameRoi({ image: full }, { x: 39, y: 29, width: 1, height: 1 });
  assert.equal(bottomRight.ok, true);
  assert.deepEqual([...bottomRight.image.rgba], [0, 128, 0, 255]);
});

test('cropFrameRoi: out-of-bounds, negative and zero-area regions are crop-failed (never clamped)', () => {
  const full = fillImage(20, 20, RED);
  const frame = { image: full };
  const cases = [
    { x: 15, y: 5, width: 10, height: 5 }, // 15+10 > 20
    { x: -1, y: 0, width: 4, height: 4 },
    { x: 0, y: 0, width: 0, height: 4 },
    { x: 0, y: 0, width: 4, height: 0 },
    { x: 1.5, y: 0, width: 4, height: 4 },
    { x: '0', y: 0, width: 4, height: 4 },
    null,
  ];
  for (const region of cases) {
    const result = cropFrameRoi(frame, region);
    assert.equal(result.ok, false, JSON.stringify(region));
    assert.equal(result.code, 'crop-failed', JSON.stringify(region));
    assert.equal(typeof result.message, 'string');
  }
});

test('cropFrameRoi: JPEG and PNG frames decode then crop; ROI hash differs from encoded hash', async () => {
  const store = new DynamicFrameStore({ scopeId: 'scope-1', dynamicSessionId: 'ds-1', now: () => 1 });
  const added = store.addFrame({
    frameId: 'jpeg-roi',
    receivedMonoMs: 1000,
    encoding: 'jpeg',
    bytes: Buffer.from(FIXTURE_JPEG444.base64, 'base64'),
    dimensions: { width: 32, height: 24 },
  });
  assert.equal(added.ok, true);
  const record = store.getFrame('jpeg-roi');
  const jpegCrop = cropFrameRoi(record, { x: 2, y: 2, width: 10, height: 10 });
  assert.equal(jpegCrop.ok, true);
  assert.equal(jpegCrop.image.width, 10);
  assert.equal(jpegCrop.image.height, 10);
  assert.equal(jpegCrop.source.encoding, 'jpeg');
  assert.equal(jpegCrop.source.sha256, record.encodedSha256);
  assert.notEqual(jpegCrop.roiSha256, record.encodedSha256);
  assert.equal(jpegCrop.roiSha256, rgbaHashOf(jpegCrop.image));

  const { encodePngRgba } = await import('../vision-t3.js');
  const png = encodePngRgba(fillImage(8, 6, BLUE));
  const pngCrop = cropFrameRoi({ encoding: 'png', bytes: png }, { x: 1, y: 1, width: 4, height: 3 });
  assert.equal(pngCrop.ok, true);
  assert.equal(pngCrop.image.width, 4);
  assert.equal(pngCrop.image.height, 3);
  assert.equal(pngCrop.source.encoding, 'png');
  assert.equal(pngCrop.source.sha256, createHash('sha256').update(png).digest('hex'));
  assert.deepEqual([...pngCrop.image.rgba.subarray(0, 4)], [0, 0, 255, 255]);
});

test('cropFrameRoi: decoder failures degrade to decoder-unavailable without throwing', () => {
  const broken = cropFrameRoi({ encoding: 'jpeg', bytes: Buffer.from([0xFF, 0xD8, 0x00, 0x01]) }, { x: 0, y: 0, width: 2, height: 2 });
  assert.equal(broken.ok, false);
  assert.equal(broken.code, 'decoder-unavailable');
  const empty = cropFrameRoi({}, { x: 0, y: 0, width: 2, height: 2 });
  assert.equal(empty.ok, false);
  assert.equal(empty.code, 'decoder-unavailable');
  const notFrame = cropFrameRoi(null, { x: 0, y: 0, width: 2, height: 2 });
  assert.equal(notFrame.ok, false);
  assert.equal(notFrame.code, 'decoder-unavailable');
});
